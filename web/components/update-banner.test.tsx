import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBannerView, isDismissed } from "./update-banner";
import type { UpdateBanner } from "@/lib/update-check";

/**
 * The dashboard's update banner (#749). What it says for each check and each
 * step of Update now, and when a dismissal hides it.
 */
const SHA = "b".repeat(40);
const behind = (over: Partial<UpdateBanner> = {}): UpdateBanner => ({
  kind: "behind",
  behindBy: 3,
  upstreamSha: SHA,
  compareUrl: "https://github.com/drkostas/hevy2garmin/compare/a...b",
  forkUrl: "https://github.com/someone/hevy2garmin",
  docsUrl: "https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy",
  canUpdate: true,
  ...over,
});
const rewritten = (): UpdateBanner => ({
  kind: "rewritten",
  upstreamSha: SHA,
  forkUrl: "https://github.com/someone/hevy2garmin",
  docsUrl: "https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy",
  canUpdate: false,
});
const render = (banner: UpdateBanner) => renderToStaticMarkup(<UpdateBannerView banner={banner} onDismiss={() => {}} />);

describe("UpdateBannerView", () => {
  it("behind: the count, See what's new and Dismiss", () => {
    const html = render(behind());
    expect(html).toContain("Update available: 3 new changes since your version");
    expect(html).toContain('href="https://github.com/drkostas/hevy2garmin/compare/a...b"');
    expect(html).toContain("See what&#x27;s new");
    expect(html).toContain("Dismiss");
  });

  it("says change, not changes, for one", () => {
    expect(render(behind({ behindBy: 1 }))).toContain("1 new change since your version");
  });

  it("a pre-rewrite fork: no count, no Update now, the fork and the docs", () => {
    const html = render(rewritten());
    expect(html).toContain("An update is available");
    expect(html).not.toMatch(/\d+ new change/);
    expect(html).not.toContain("Update now");
    expect(html).toContain('href="https://github.com/someone/hevy2garmin"');
    expect(html).toContain('href="https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy"');
  });
});

describe("isDismissed", () => {
  it("hides the banner for the upstream commit it was dismissed at", () => {
    expect(isDismissed(behind(), SHA)).toBe(true);
  });

  it("brings it back when upstream has a newer commit", () => {
    expect(isDismissed(behind({ upstreamSha: "c".repeat(40) }), SHA)).toBe(false);
  });

  it("shows it when nothing was dismissed", () => {
    expect(isDismissed(behind(), null)).toBe(false);
  });
});
