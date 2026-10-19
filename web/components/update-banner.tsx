"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import type { UpdateBanner as Banner } from "@/lib/update-check";

/**
 * The dashboard's "update available" banner for a fork (#749).
 *
 * Loads after the page renders, from /api/update-check, so the dashboard
 * never waits on GitHub; any failure there means no banner. Dismissing it
 * hides it until upstream has a newer commit. The dismissed commit is kept in
 * this browser's localStorage: it is a display preference, so it needs no
 * route, no database write and nothing more to protect.
 */
const DISMISSED_KEY = "h2g-update-dismissed";

/** True when the banner was dismissed at this same upstream commit. */
export function isDismissed(banner: Banner, dismissedSha: string | null): boolean {
  return dismissedSha === banner.upstreamSha;
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(sha: string) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, sha);
  } catch {
    // Without storage the dismissal lasts until the next page load.
  }
}

const link = "font-medium text-teal underline";

export function UpdateBannerView({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }) {
  const n = banner.behindBy ?? 0;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-teal/40 bg-teal/10 p-4">
      <p className="min-w-0 flex-1 basis-60 text-sm text-text">
        {banner.kind === "behind" ? (
          <>Update available: {n} new {n === 1 ? "change" : "changes"} since your version.</>
        ) : (
          <>
            An update is available. Your fork was made before this project&apos;s history was rewritten, so update it on
            GitHub: <a href={banner.forkUrl} className={link}>open your fork</a> and follow{" "}
            <a href={banner.docsUrl} className={link}>the update steps</a>.
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {banner.kind === "behind" && banner.compareUrl && (
          <a href={banner.compareUrl} className={`text-xs ${link}`}>
            See what&apos;s new
          </a>
        )}
        <button type="button" onClick={onDismiss} className="text-xs font-medium text-text-muted hover:text-text">
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function UpdateBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(withBasePath("/api/update-check"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { banner?: Banner | null } | null) => {
        const b = d?.banner ?? null;
        if (!cancelled && b && !isDismissed(b, readDismissed())) setBanner(b);
      })
      .catch(() => {
        // No banner. The dashboard is complete without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!banner) return null;
  return (
    <UpdateBannerView
      banner={banner}
      onDismiss={() => {
        writeDismissed(banner.upstreamSha);
        setBanner(null);
      }}
    />
  );
}
