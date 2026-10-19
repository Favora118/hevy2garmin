import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * POST /api/update-fork — the dashboard's Update now (#749): GitHub's
 * merge-upstream on the fork, with the saved token. Session-gated, refused in
 * the demo and self-hosted, and the token never appears in any answer.
 */

const TOKEN = "ghp_secret_token_value";
const DEPLOYED = "a".repeat(40);

const auth = { enabled: true, valid: true };
vi.mock("@/lib/auth", () => ({
  authEnabled: () => auth.enabled,
  verifySession: async (cookie: string | null) => auth.valid && cookie === "good",
  SESSION_COOKIE: "h2g_session",
}));
const cookie = { value: "good" as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}));

const state: { pat: string | null; cache: unknown } = { pat: null, cache: undefined };
vi.mock("@/lib/db", () => {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (q.includes("FROM platform_credentials")) return Promise.resolve(state.pat ? [{ credentials: { pat: state.pat } }] : []);
    if (/^\s*SELECT value FROM app_cache/.test(q)) return Promise.resolve(state.cache === undefined ? [] : [{ value: state.cache }]);
    if (/^\s*INSERT INTO app_cache/.test(q)) {
      state.cache = values[1];
      return Promise.resolve([]);
    }
    return Promise.reject(new Error("unexpected query: " + q));
  }) as unknown as { json: (v: unknown) => unknown };
  tag.json = (v) => v;
  return { getDb: () => tag };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { POST } from "./route";

const ENV = ["H2G_UPDATE_CHECK", "H2G_UPSTREAM_REPO", "DEMO_MODE", "VERCEL", "VERCEL_GIT_COMMIT_SHA", "HEVY2GARMIN_COMMIT_SHA", "GITHUB_REPO", "GITHUB_PAT", "VERCEL_GIT_REPO_OWNER", "VERCEL_GIT_REPO_SLUG"];
const saved: Record<string, string | undefined> = {};

/** The fork's default branch is main; merge-upstream answers `status`. */
function mergeAnswers(status: number) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === "https://api.github.com/repos/someone/hevy2garmin" && (init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ default_branch: "main" }));
    }
    if (url.endsWith("/merge-upstream")) return new Response(JSON.stringify({ message: "x" }), { status });
    return new Response("{}", { status: 404 });
  });
}

async function post() {
  const res = await POST();
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

const cachedCheck = {
  checkedAt: new Date().toISOString(),
  upstream: "drkostas/hevy2garmin",
  deployedSha: DEPLOYED,
  upstreamSha: "b".repeat(40),
  behindBy: 3,
  status: "behind",
};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VERCEL = "1";
  process.env.VERCEL_GIT_COMMIT_SHA = DEPLOYED;
  process.env.VERCEL_GIT_REPO_OWNER = "someone";
  process.env.VERCEL_GIT_REPO_SLUG = "hevy2garmin";
  auth.enabled = true;
  auth.valid = true;
  cookie.value = "good";
  state.pat = TOKEN;
  state.cache = { ...cachedCheck };
  fetchMock.mockReset();
  mergeAnswers(200);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("POST /api/update-fork", () => {
  it("syncs the fork and marks the cache so the banner stops offering it", async () => {
    const { status, body, text } = await post();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    const merge = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/merge-upstream"))!;
    expect(merge[0]).toBe("https://api.github.com/repos/someone/hevy2garmin/merge-upstream");
    expect(JSON.parse(merge[1].body)).toEqual({ branch: "main" });
    expect(merge[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(state.cache).toMatchObject({ status: "updating" });
    expect(text).not.toContain(TOKEN);
  });

  it.each([409, 422])("%i: the fork and the docs links, once, no retry", async (code) => {
    mergeAnswers(code);
    const { status, body, text } = await post();
    expect(status).toBe(409);
    expect(body).toEqual({
      ok: false,
      reason: "cannot-merge",
      forkUrl: "https://github.com/someone/hevy2garmin",
      docsUrl: "https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy",
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/merge-upstream"))).toHaveLength(1);
    expect(state.cache).toMatchObject({ status: "behind" });
    expect(text).not.toContain(TOKEN);
  });

  it.each([401, 403])("%i: the token can't sync the fork, and the token is not echoed", async (code) => {
    mergeAnswers(code);
    const { status, body, text } = await post();
    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, reason: "token" });
    expect(String(body.message)).toMatch(/repo/);
    expect(String(body.message)).toMatch(/workflow/);
    expect(text).not.toContain(TOKEN);
  });

  it("any other GitHub failure is a 502 without the token", async () => {
    mergeAnswers(500);
    const { status, body, text } = await post();
    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, reason: "failed" });
    expect(text).not.toContain(TOKEN);
  });

  it("no saved token: refused, GitHub not called", async () => {
    state.pat = null;
    const { status, body } = await post();
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, reason: "no-token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("self-hosted: refused, GitHub not called", async () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.HEVY2GARMIN_COMMIT_SHA = DEPLOYED;
    process.env.GITHUB_REPO = "someone/hevy2garmin";
    const { status, body } = await post();
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, reason: "self-hosted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nothing to update (turned off, or the upstream repo itself): refused, GitHub not called", async () => {
    process.env.H2G_UPDATE_CHECK = "off";
    expect((await post()).status).toBe(400);
    delete process.env.H2G_UPDATE_CHECK;
    process.env.VERCEL_GIT_REPO_OWNER = "drkostas";
    expect((await post()).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demo: refused, GitHub not called", async () => {
    process.env.DEMO_MODE = "true";
    const { status, body } = await post();
    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no session: refused, GitHub not called", async () => {
    cookie.value = undefined;
    const { status } = await post();
    expect(status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a bad session: refused, GitHub not called", async () => {
    auth.valid = false;
    expect((await post()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
