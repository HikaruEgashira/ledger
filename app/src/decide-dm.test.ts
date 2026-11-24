import { describe, expect, it } from "bun:test";
import { parseReply, plan, type Open } from "./decide-dm.ts";

const O = (key: string): Open => ({ key, kind: "task", ref: key, url: "u", title: "t", question: "q", options: ["A", "B"] });

describe("decide-dm", () => {
  it("parses numbered, exact and free-text replies", () => {
    expect(parseReply("2", ["A", "B"])).toEqual({ choice: "B", custom: false });
    expect(parseReply("1.", ["A", "B"])).toEqual({ choice: "A", custom: false });
    expect(parseReply("A", ["A", "B"])).toEqual({ choice: "A", custom: false });
    expect(parseReply("3", ["A", "B"])).toEqual({ choice: "3", custom: true });
    expect(parseReply(" 先に SRE に確認して ", ["A", "B"])).toEqual({ choice: "先に SRE に確認して", custom: true });
  });
  it("posts new questions, watches posted ones and drops answered ones", () => {
    const p = plan([O("a"), O("b")], { b: { channel: "D1", ts: "1.2", at: "x" }, gone: { channel: "D1", ts: "1.3", at: "x" } });
    expect(p.post.map((o) => o.key)).toEqual(["a"]);
    expect(p.watch.map((o) => [o.key, o.ts])).toEqual([["b", "1.2"]]);
    expect(p.stale).toEqual(["gone"]);
  });
});
