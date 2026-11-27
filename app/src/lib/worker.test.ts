import { expect, test } from "bun:test";
import { oneShot, SCOPE_MODEL } from "./worker.ts";

test("oneShot swaps model/effort/output and the prompt", () => {
  const cmd = ["env", "claude", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "-p", "old"];
  expect(oneShot(cmd, "hi", { model: "opus", effort: "low", json: true })).toEqual(["env", "claude", "--model", "opus", "--effort", "low", "--output-format", "json", "-p", "hi"]);
  expect(oneShot(cmd, "hi")).toEqual([...cmd.slice(0, -1), "hi"]);
});

test("conflict scope resolves to haiku at high effort", () => {
  expect(SCOPE_MODEL["authored-conflict"]).toEqual({ model: "haiku", effort: "high" });
  const cmd = ["claude", "--model", "opus", "-p", "old"];
  expect(oneShot(cmd, "x", SCOPE_MODEL["authored-conflict"])).toEqual(["claude", "--model", "haiku", "--effort", "high", "-p", "x"]);
});
