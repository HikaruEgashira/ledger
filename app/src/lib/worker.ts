#!/usr/bin/env bun
// Build a one-shot claude call from config worker_command, overriding model/effort; CLI reads the prompt from stdin.
import { join, resolve } from "node:path";
import { localConfig } from "./org.ts";

const ROOT = resolve(import.meta.dir, "../../..");
export function oneShot(command: string[], prompt: string, opts: { model?: string; effort?: string; json?: boolean } = {}): string[] {
  const out: string[] = [];
  const base = command.slice(0, -2);
  for (let i = 0; i < base.length; i++) {
    const a = base[i]!;
    if ((a === "--model" && opts.model) || (a === "--effort" && opts.effort)) i++;
    else if (a === "--output-format" && opts.json) i++;
    else if (!(a === "--verbose" && opts.json)) out.push(a);
  }
  if (opts.model) out.push("--model", opts.model);
  if (opts.effort) out.push("--effort", opts.effort);
  if (opts.json) out.push("--output-format", "json");
  return [...out, "-p", prompt];
}
// Daily batches (retro, auto-decide) use a strong model at low effort.
export const BATCH = { model: "opus", effort: "low" };
export const workerCommand = (): string[] => localConfig(join(ROOT, "config/config.toml")).worker_command;

if (import.meta.main) {
  const prompt = await Bun.stdin.text();
  const p = Bun.spawn(oneShot(workerCommand(), prompt, BATCH), { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  process.exit(await p.exited);
}
