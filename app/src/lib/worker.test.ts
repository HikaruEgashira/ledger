import { expect, test } from "bun:test";
import { oneShot } from "./worker.ts";

test("oneShot swaps model/effort/output and the prompt", () => {
  const cmd = ["env", "claude", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "-p", "old"];
  expect(oneShot(cmd, "hi", { model: "opus", effort: "low", json: true })).toEqual(["env", "claude", "--model", "opus", "--effort", "low", "--output-format", "json", "-p", "hi"]);
  expect(oneShot(cmd, "hi")).toEqual([...cmd.slice(0, -1), "hi"]);
});
