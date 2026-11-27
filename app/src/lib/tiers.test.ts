import { expect, test } from "bun:test";
import { COOLDOWN_MS, evolve, HAIKU, tierFor, type Outcome } from "./tiers.ts";

const o = (scope: string, model: string, ok: boolean, i: number, kind = "authored"): Outcome => ({ scope, kind, model, ok, at: new Date(1000 + i).toISOString() });
const many = (scope: string, model: string, okN: number, failN: number, kind?: string) =>
  [...Array(okN)].map((_, i) => o(scope, model, true, i, kind)).concat([...Array(failN)].map((_, i) => o(scope, model, false, okN + i, kind)));

test("promotes a reliable default scope to haiku", () => {
  const { learned, changes } = evolve(many("authored-ci_failed", "default", 10, 0), {}, 10_000);
  expect(learned["authored-ci_failed"]!.tier).toEqual(HAIKU);
  expect(changes.length).toBe(1);
});

test("demotes a failing haiku seed and holds it through the cooldown", () => {
  const { learned } = evolve(many("authored-conflicting", "haiku", 1, 4), {}, 10_000);
  expect(tierFor("authored-conflicting", learned)).toBeUndefined();
  const later = many("authored-conflicting", "default", 10, 0).map((x) => ({ ...x, at: new Date(20_000).toISOString() }));
  expect(evolve(later, learned, 20_000).changes).toEqual([]);
  expect(evolve(later, learned, 10_000 + COOLDOWN_MS + 30_000).learned["authored-conflicting"]!.tier).toEqual(HAIKU);
});

test("reviews never move because their exit code is not a verdict", () => {
  expect(evolve(many("team-repo", "default", 20, 0, undefined as any).map((x) => ({ ...x, kind: "review" })), {}).changes).toEqual([]);
});

test("needs enough runs before changing", () => {
  expect(evolve(many("authored-re_request", "default", 9, 0), {}).changes).toEqual([]);
});
