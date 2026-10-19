/**
 * Whether a fork's deployed commit is behind upstream `main`, for the
 * dashboard's update banner, and the fork sync behind its **Update now** (#749).
 *
 * Built to fail towards no banner: GitHub being slow, rate limited, down or
 * unreachable means no banner, never an error on the page. The answer is
 * cached in `app_cache` so ordinary page views do not call GitHub. Never log
 * or return the GitHub token (see `github.ts`).
 */
import { demoMode } from "./demo";
import { getGithubRepo } from "./github";
import type { Sql } from "./pending-store";

export const UPDATE_CACHE_KEY = "update_check";
export const DEFAULT_UPSTREAM = "drkostas/hevy2garmin";
/** How long a check is reused before GitHub is asked again. */
export const CHECK_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The commit date of dc5905a, the last commit shared with the pre-rewrite
 * history of drkostas/hevy2garmin (#719). Forks made before the rewrite on
 * 9 September 2026 compare as diverged with a merge base at or before it, and
 * every rewritten commit is dated 8 April 2026 or later.
 */
const LAST_SHARED_WITH_PRE_REWRITE = Date.parse("2026-04-04T20:36:42Z");

const API = "https://api.github.com";
const SHA = /^[0-9a-f]{40}$/;

export interface UpdateTarget {
  upstream: string;
  fork: string;
  deployedSha: string;
}

/**
 * `behind`: upstream has `behindBy` new commits. `current`: nothing new.
 * `rewritten`: a fork from before the history rewrite, which no count or
 * merge-upstream can serve. `updating`: Update now worked and the new
 * deployment has not arrived yet.
 */
export type UpdateStatus = "behind" | "current" | "rewritten" | "updating";

export interface UpdateCheck {
  checkedAt: string;
  upstream: string;
  deployedSha: string;
  upstreamSha: string;
  behindBy: number;
  status: UpdateStatus;
}

export interface UpdateBanner {
  kind: "behind" | "rewritten";
  behindBy?: number;
  upstreamSha: string;
  compareUrl?: string;
  forkUrl: string;
  docsUrl: string;
  canUpdate: boolean;
}

function checkDisabled(): boolean {
  const v = (process.env.H2G_UPDATE_CHECK ?? "").trim().toLowerCase();
  return v === "off" || v === "false" || v === "0" || v === "no";
}

/**
 * What to compare, or null when there is nothing to check: the check is
 * turned off, this is the demo, there is no deployed commit or no fork repo,
 * or the deployment is the upstream repo itself.
 */
export function updateTarget(): UpdateTarget | null {
  if (checkDisabled() || demoMode()) return null;
  const deployedSha = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.HEVY2GARMIN_COMMIT_SHA ?? "").trim();
  const fork = getGithubRepo();
  const upstream = process.env.H2G_UPSTREAM_REPO?.trim() || DEFAULT_UPSTREAM;
  if (!deployedSha || !fork || fork.toLowerCase() === upstream.toLowerCase()) return null;
  return { upstream, fork, deployedSha };
}

/** Update now is offered only on Vercel, where a new fork commit redeploys, and with a saved token. */
export function canUpdateFork(pat: string | null): boolean {
  return Boolean(process.env.VERCEL) && Boolean(pat);
}

function github(fetchImpl: typeof fetch, pat: string | null, path: string, init: RequestInit = {}) {
  return fetchImpl(`${API}/repos/${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

type Compared = Omit<UpdateCheck, "checkedAt">;

/** Ask GitHub how far the deployed commit is behind upstream `main`, or null on any failure. */
async function compareWithUpstream(target: UpdateTarget, pat: string | null, fetchImpl: typeof fetch): Promise<Compared | null> {
  try {
    const head = await github(fetchImpl, pat, `${target.upstream}/commits/main`, {
      headers: { Accept: "application/vnd.github.sha" },
    });
    if (!head.ok) return null;
    const upstreamSha = (await head.text()).trim();
    if (!SHA.test(upstreamSha)) return null;

    const base = { upstream: target.upstream, deployedSha: target.deployedSha, upstreamSha };
    const rewritten: Compared = { ...base, behindBy: 0, status: "rewritten" };

    const res = await github(fetchImpl, pat, `${target.upstream}/compare/${target.deployedSha}...${upstreamSha}`);
    if (!res.ok) {
      // Unrelated histories. Real pre-rewrite forks still share the first
      // commits and land in the date check below; this is the fallback.
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      return res.status === 404 && /no common ancestor/i.test(String(body.message ?? "")) ? rewritten : null;
    }
    const d = (await res.json()) as {
      status?: string;
      ahead_by?: number;
      merge_base_commit?: { commit?: { committer?: { date?: string } } } | null;
    };
    if (!d.merge_base_commit) return rewritten;
    // The compare runs deployed...upstream, so GitHub's "ahead" is upstream
    // being ahead of the deployment, and "behind" is the fork being ahead.
    if (d.status === "identical" || d.status === "behind") return { ...base, behindBy: 0, status: "current" };
    if (d.status === "diverged" && target.upstream.toLowerCase() === DEFAULT_UPSTREAM) {
      const mergeBaseAt = Date.parse(d.merge_base_commit.commit?.committer?.date ?? "");
      if (!Number.isNaN(mergeBaseAt) && mergeBaseAt <= LAST_SHARED_WITH_PRE_REWRITE) return rewritten;
    }
    if (d.status === "ahead" || d.status === "diverged") {
      const behindBy = Number(d.ahead_by);
      if (!Number.isInteger(behindBy) || behindBy < 0) return null;
      return { ...base, behindBy, status: behindBy > 0 ? "behind" : "current" };
    }
    return null;
  } catch {
    return null;
  }
}

function isUpdateCheck(v: unknown): v is UpdateCheck {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.checkedAt === "string" &&
    !Number.isNaN(Date.parse(c.checkedAt)) &&
    typeof c.upstream === "string" &&
    typeof c.deployedSha === "string" &&
    typeof c.upstreamSha === "string" &&
    typeof c.behindBy === "number" &&
    ["behind", "current", "rewritten", "updating"].includes(c.status as string)
  );
}

async function readCached(sql: Sql): Promise<UpdateCheck | null> {
  const rows = (await sql`
    SELECT value FROM app_cache WHERE key = ${UPDATE_CACHE_KEY} LIMIT 1
  `.catch(() => [] as Array<{ value: unknown }>)) as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  return isUpdateCheck(v) ? v : null;
}

async function writeCached(sql: Sql, value: UpdateCheck): Promise<void> {
  await sql`
    INSERT INTO app_cache (key, value, updated_at)
    VALUES (${UPDATE_CACHE_KEY}, ${sql.json(value)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `.catch(() => {
    // Best effort: the answer is still right, the next view just asks again.
  });
}

/**
 * The cached check when it is fresh and for this deployment and upstream,
 * otherwise a new one from GitHub, cached. Null on any GitHub failure, which
 * leaves the cache as it was.
 */
export async function readUpdateCheck(
  sql: Sql,
  target: UpdateTarget,
  pat: string | null,
  { fetchImpl = fetch, now = Date.now() }: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<UpdateCheck | null> {
  const cached = await readCached(sql);
  if (
    cached &&
    cached.upstream === target.upstream &&
    cached.deployedSha === target.deployedSha &&
    now - Date.parse(cached.checkedAt) < CHECK_WINDOW_MS
  ) {
    return cached;
  }
  const compared = await compareWithUpstream(target, pat, fetchImpl);
  if (!compared) return null;
  const check: UpdateCheck = { ...compared, checkedAt: new Date(now).toISOString() };
  await writeCached(sql, check);
  return check;
}

/** The README section on updating a fork, including the "Discard N commits" case. */
export function docsUrl(upstream: string): string {
  return `https://github.com/${upstream}#vercel-fork-based-deploy`;
}

export function forkUrl(fork: string): string {
  return `https://github.com/${fork}`;
}

/** What the dashboard shows for a check, or null for no banner. */
export function bannerFor(check: UpdateCheck | null, target: UpdateTarget, canUpdate: boolean): UpdateBanner | null {
  if (!check) return null;
  const links = { forkUrl: forkUrl(target.fork), docsUrl: docsUrl(target.upstream) };
  if (check.status === "rewritten") {
    return { kind: "rewritten", upstreamSha: check.upstreamSha, ...links, canUpdate: false };
  }
  if (check.status !== "behind" || check.behindBy <= 0) return null;
  return {
    kind: "behind",
    behindBy: check.behindBy,
    upstreamSha: check.upstreamSha,
    compareUrl: `https://github.com/${target.upstream}/compare/${check.deployedSha}...${check.upstreamSha}`,
    ...links,
    canUpdate,
  };
}
