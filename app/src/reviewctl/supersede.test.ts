import { describe, expect, it } from "vite-plus/test";
import { changeRequestSuperseded } from "./commands.ts";
import { changeRequestActive, standingChangeRequests } from "./core.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

const row = (head = OLD): Record<string, any> => ({
  status: "changes_requested",
  change_request: { head_sha: head, verification: "confirmed", write_outcome: "confirmed" },
});
const live = (reviews: unknown, head = NEW) => ({
  reviewDecision: "CHANGES_REQUESTED",
  headRefOid: head,
  changeRequestReviews: reviews,
});

describe("changeRequestActive", () => {
  it("treats own old-head request as superseded", () =>
    expect(changeRequestActive(row(), live([{ login: "me", commit: OLD }]))).toBe(false));
  it("keeps same-head request active", () =>
    expect(changeRequestActive(row(), live([{ login: "me", commit: OLD }], OLD))).toBe(true));
  it("keeps other reviewer request active", () =>
    expect(
      changeRequestActive(
        row(),
        live([
          { login: "me", commit: OLD },
          { login: "x", commit: NEW },
        ]),
      ),
    ).toBe(true));
  it("keeps unknown review data active", () => {
    expect(changeRequestActive(row(), live(null))).toBe(true);
    expect(changeRequestActive(row(), live([]))).toBe(true);
  });
});

describe("standingChangeRequests", () => {
  const review = (state: string, at: string) => ({
    state,
    submittedAt: at,
    author: { login: "me" },
    commit: { oid: OLD },
  });
  it("lets the latest decisive review win", () =>
    expect(
      standingChangeRequests([
        review("CHANGES_REQUESTED", "2026-01-01"),
        review("COMMENTED", "2026-01-02"),
      ]),
    ).toEqual([{ login: "me", commit: OLD }]));
  it.each(["DISMISSED", "APPROVED"])("clears on %s", (state) =>
    expect(
      standingChangeRequests([
        review("CHANGES_REQUESTED", "2026-01-01"),
        review(state, "2026-01-02"),
      ]),
    ).toEqual([]),
  );
});

describe("changeRequestSuperseded", () => {
  it("selects a row whose head moved", () =>
    expect(changeRequestSuperseded({ ...row(), live: { headRefOid: NEW } })).toBe(true));
  it("skips a row on the same head", () =>
    expect(changeRequestSuperseded({ ...row(), live: { headRefOid: OLD } })).toBe(false));
});
