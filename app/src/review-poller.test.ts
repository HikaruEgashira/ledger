import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { type Gh, loadScopes, MIN_REMAINING, poll, PollerExit, qualifier } from "./review-poller.ts";

const ORG = "example-org";
const url = (n: number) => `https://github.com/${ORG}/repo/pull/${n}`;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "poller-"));
  mkdirSync(join(root, "profiles"));
  writeFileSync(join(root, "profiles/p.md"), "x");
  return root;
}
const config = { exclude_authors: ["me"], scopes: [{ name: "team", repo: `${ORG}/repo`, profile: "profiles/p.md" }] };

function fakeGh(pages: Record<string, [string, string][]>[], remaining = 5000): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const gh: Gh = (args) => {
    calls.push(args);
    const page = pages[i++] ?? {};
    const nodes = Object.entries(page).flatMap(([, v]) => v.map(([u, h]) => ({ url: u, headRefOid: h })));
    return JSON.stringify({
      data: { rateLimit: { cost: 1, remaining }, search: { nodes: [...nodes, null, { url: "https://github.com/other/x/pull/1", headRefOid: "z" }], pageInfo: { hasNextPage: i < pages.length, endCursor: `c${i}` } } },
    });
  };
  return { gh, calls };
}

describe("loadScopes", () => {
  it("validates and merges exclude_authors", () => {
    const root = workspace();
    const s = loadScopes(structuredClone(config), root, ORG, "cfg");
    expect(s[0].exclude_authors).toEqual(["me"]);
    expect(qualifier(s[0], ORG)).toBe(`repo:${ORG}/repo -author:me`);
  });
  it.each([
    [{ scopes: [] }, "cfg: scopes is empty"],
    [{ scopes: [{ name: "a", repo: `${ORG}/r`, profile: "missing.md" }] }, "cfg: scope a profile not found"],
    [{ scopes: [{ name: "a", profile: "profiles/p.md" }] }, "cfg: scope a needs exactly one of authors or repo"],
    [{ scopes: [{ name: "a", repo: "other/r", profile: "profiles/p.md" }] }, `cfg: scope a repo must be under ${ORG}`],
    [{ scopes: [{ name: "a", authors: ["x"], repos: ["other/r"], profile: "profiles/p.md" }] }, `cfg: scope a repos needs authors and ${ORG} repos`],
  ])("rejects %j", (c, msg) => {
    expect(() => loadScopes(c, workspace(), ORG, "cfg")).toThrow(new PollerExit(msg));
  });
  it("builds author qualifiers", () => {
    expect(qualifier({ name: "a", profile: "", authors: ["x", "y"] }, ORG)).toBe(`org:${ORG} author:x author:y`);
    expect(qualifier({ name: "a", profile: "", authors: ["x"], repos: [`${ORG}/r`] }, ORG)).toBe(`repo:${ORG}/r author:x`);
    expect(qualifier({ name: "a", profile: "", authors: ["x"], title: "t y" }, ORG)).toBe(`org:${ORG} author:x in:title "t y"`);
  });
});

describe("poll", () => {
  const base = (root: string) => ({ root, config: structuredClone(config), orgName: ORG });

  it("first run is a full sweep that enqueues in-scope PRs missing from the ledger", () => {
    const root = workspace();
    writeFileSync(join(root, "pull_requests.jsonl"), JSON.stringify({ url: url(1) }) + "\n");
    const { gh, calls } = fakeGh([{ a: [[url(1), "h1"], [url(2), "h2"]] }]);
    const out = poll({ ...base(root), gh, enqueue: () => true, now: new Date("2026-11-03T00:00:00Z") });
    expect(out).toBe(`{"full":true,"open":2,"queued":["${url(2)}"]}`);
    expect(calls[0].some((a) => a.includes("updated:"))).toBe(false);
    expect(readFileSync(join(root, "logs/review-poller/last_full_sweep.txt"), "utf8")).toBe("2026-11-03T00:00:00.000+00:00");
  });

  it("full sweep re-enqueues stale PRs known to state but absent from the ledger", () => {
    const root = workspace();
    const dir = join(root, "logs/review-poller");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "heads.json"), JSON.stringify({ [url(1)]: "h1" }));
    writeFileSync(join(dir, "last_poll.txt"), "2026-11-03T00:10:00+00:00");
    writeFileSync(join(dir, "last_full_sweep.txt"), "2026-11-02T00:00:00+00:00");
    const { gh } = fakeGh([{ a: [[url(1), "h1"]] }]);
    const out = poll({ ...base(root), gh, enqueue: () => true, now: new Date("2026-11-03T00:20:00Z") });
    expect(out).toBe(`{"full":true,"open":1,"queued":["${url(1)}"]}`);
  });

  it("enqueues changed heads incrementally, paginates, and keeps failures for retry", () => {
    const root = workspace();
    const dir = join(root, "logs/review-poller");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "heads.json"), JSON.stringify({ [url(1)]: "h1", [url(9)]: "h9" }));
    writeFileSync(join(dir, "last_poll.txt"), "2026-11-03T00:10:00.123456+00:00");
    writeFileSync(join(dir, "last_full_sweep.txt"), "2026-11-03T00:00:00+00:00");
    const { gh, calls } = fakeGh([{ a: [[url(1), "h1"], [url(2), "h2"]] }, { a: [[url(3), "h3"]] }]);
    const out = poll({ ...base(root), gh, enqueue: (u) => u !== url(3), now: new Date("2026-11-03T00:20:00Z") });
    expect(out).toBe(`{"full":false,"open":3,"queued":["${url(2)}"]}`);
    expect(calls[0]).toContain(`q=repo:${ORG}/repo -author:me is:pr is:open archived:false updated:>=2026-11-03T00:05:00Z`);
    expect(calls[1].slice(-2)).toEqual(["-f", "cursor=c1"]);
    expect(JSON.parse(readFileSync(join(dir, "heads.json"), "utf8"))).toEqual({ [url(1)]: "h1", [url(9)]: "h9", [url(2)]: "h2" });
    expect(readFileSync(join(dir, "last_poll.txt"), "utf8")).toBe("2026-11-03T00:10:00.123456+00:00");
  });

  it("dry-run reports changes without writing state", () => {
    const root = workspace();
    const { gh, calls } = fakeGh([{ a: [[url(1), "h1"]] }]);
    const out = poll({ ...base(root), gh, dryRun: true });
    expect(JSON.parse(out)).toEqual({ open: 1, changed: { [url(1)]: "team" } });
    expect(calls[0].some((a) => a.includes("updated:"))).toBe(false);
    expect(existsSync(join(root, "logs/review-poller/heads.json"))).toBe(false);
  });

  it("stops when GraphQL rate limit is low", () => {
    const { gh } = fakeGh([{}], MIN_REMAINING - 1);
    expect(() => poll({ ...base(workspace()), gh })).toThrow("GraphQL rate limit low; skipping until next poll");
  });
});
