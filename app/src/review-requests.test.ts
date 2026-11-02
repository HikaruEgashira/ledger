import { describe, expect, it } from "bun:test";
import { dismissedReview } from "./review-requests.ts";

const sha = "a".repeat(40);
const pr = (reviews: object[], hasNextPage = false) => ({
  url: "https://github.com/example-org/repo/pull/1",
  number: 1,
  state: "OPEN",
  baseRefOid: sha,
  headRefOid: sha,
  updatedAt: "2026-10-23T00:00:00Z",
  repository: { nameWithOwner: "example-org/repo" },
  latestReviews: { nodes: reviews, pageInfo: { hasNextPage } },
});

describe("dismissedReview", () => {
  it("matches when the login's latest review is dismissed", () => {
    const got = dismissedReview(pr([{ author: { login: "Me" }, state: "DISMISSED" }]), "me");
    expect(got?.url).toBe("https://github.com/example-org/repo/pull/1");
  });

  it("ignores other states and other reviewers", () => {
    expect(dismissedReview(pr([{ author: { login: "me" }, state: "APPROVED" }]), "me")).toBeNull();
    expect(dismissedReview(pr([{ author: { login: "x" }, state: "DISMISSED" }]), "me")).toBeNull();
  });

  it("rejects incomplete latestReviews", () => {
    expect(() => dismissedReview(pr([], true), "me")).toThrow(/latestReviews is incomplete/);
  });
});
