import { expect, test } from "bun:test";
import { main } from "./intakectl.ts";

const URL = "https://github.com/C-FO/example/pull/1";

test("manual intake without the poller source and scope is rejected", () => {
  expect(main(["add", URL, "--reason", "manual"])).not.toBe(0);
  expect(main(["add", URL, "--reason", "manual", "--source", "slack", "--scope", "x"])).not.toBe(0);
  expect(main(["add", URL, "--reason", "manual", "--source", "review-poller"])).not.toBe(0);
});
