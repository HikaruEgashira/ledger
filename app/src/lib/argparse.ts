// Subset of Python argparse semantics the ported CLIs rely on.
import { normalize } from "node:path";
import { ExitCode } from "./py.ts";

export type Kind = "flag" | "string" | "int" | "append" | "path";
export interface Opt {
  kind: Kind;
  required?: boolean;
  choices?: string[];
  default?: unknown;
}
export interface Positional {
  name: string;
  nargs?: "?" | "+";
}
export interface Command<A> {
  positionals?: Positional[];
  options?: Record<string, Opt>;
  run: (args: A) => void;
}
export interface Program<A> {
  prog: string;
  globals?: Record<string, Opt>;
  commands: Record<string, Command<A>>;
}

export class UsageError extends Error {}

/** Exact name or unique prefix, as argparse allows. */
function matchOption(name: string, options: Record<string, Opt>): string | null {
  if (name in options) return name;
  const hits = Object.keys(options).filter((o) => o.startsWith(name));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1)
    throw new UsageError(
      `ambiguous option: --${name} could match ${hits.map((h) => "--" + h).join(", ")}`,
    );
  return null;
}

/** pathlib.Path(str) normalisation. */
export function pyPath(raw: string): string {
  if (!raw) return ".";
  const n = normalize(raw);
  return n === "/" ? n : n.replace(/\/+$/, "");
}

const dest = (key: string) => key.replace(/-/g, "_");

function defaults(args: Record<string, any>, options: Record<string, Opt>): void {
  for (const [key, opt] of Object.entries(options))
    args[dest(key)] =
      opt.kind === "flag" ? false : opt.kind === "append" ? null : (opt.default ?? null);
}

function convert(key: string, opt: Opt, value: string, current: unknown): unknown {
  if (opt.choices && !opt.choices.includes(value))
    throw new UsageError(
      `argument --${key}: invalid choice: '${value}' (choose from ${opt.choices.map((x) => `'${x}'`).join(", ")})`,
    );
  if (opt.kind === "int") {
    if (!/^\s*[-+]?\d+\s*$/.test(value))
      throw new UsageError(`argument --${key}: invalid int value: '${value}'`);
    return Number.parseInt(value, 10);
  }
  if (opt.kind === "path") return pyPath(value);
  if (opt.kind === "append") return [...((current as string[]) ?? []), value];
  return value;
}

/** Parse options from argv[i..]; returns positionals and the index where parsing stopped. */
function parseTokens(
  argv: string[],
  start: number,
  options: Record<string, Opt>,
  args: Record<string, any>,
  stopAtPositional: boolean,
) {
  const positionals: string[] = [];
  const seen = new Set<string>();
  let onlyPositionals = false;
  let i = start;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (onlyPositionals || !token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
      if (stopAtPositional) break;
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (!token.startsWith("--")) throw new UsageError(`unrecognized arguments: ${token}`);
    const [raw, inline] = token.slice(2).split(/=(.*)/s);
    const key = matchOption(raw, options);
    if (key === null) throw new UsageError(`unrecognized arguments: ${token}`);
    const opt = options[key];
    seen.add(key);
    if (opt.kind === "flag") {
      if (inline !== undefined)
        throw new UsageError(`argument --${key}: ignored explicit argument '${inline}'`);
      args[dest(key)] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (
      value === undefined ||
      (inline === undefined && value.startsWith("-") && !/^-\d/.test(value))
    )
      throw new UsageError(`argument --${key}: expected one argument`);
    args[dest(key)] = convert(key, opt, value, args[dest(key)]);
  }
  return { positionals, seen, next: i };
}

export function parseArgs<A>(program: Program<A>, argv: string[]): [Command<A>, A] {
  const args: Record<string, any> = {};
  const globals = program.globals ?? {};
  defaults(args, globals);
  const head = parseTokens(argv, 0, globals, args, true);
  const missingGlobals = Object.entries(globals).filter(
    ([k, o]) => o.required && !head.seen.has(k),
  );
  if (missingGlobals.length)
    throw new UsageError(
      `the following arguments are required: ${missingGlobals.map(([k]) => "--" + k).join(", ")}`,
    );
  const name = argv[head.next];
  if (name === undefined) throw new UsageError("the following arguments are required: command");
  const command = program.commands[name];
  if (!command) {
    const choices = Object.keys(program.commands)
      .map((c) => `'${c}'`)
      .join(", ");
    throw new UsageError(`argument command: invalid choice: '${name}' (choose from ${choices})`);
  }
  const options = command.options ?? {};
  defaults(args, options);
  const { positionals, seen } = parseTokens(argv, head.next + 1, options, args, false);
  const specs = command.positionals ?? [];
  const missing: string[] = [];
  let p = 0;
  for (const spec of specs) {
    if (spec.nargs === "+") {
      const rest = specs.length - specs.indexOf(spec) - 1;
      const take = positionals.slice(p, positionals.length - rest);
      if (!take.length) missing.push(spec.name);
      args[spec.name] = take;
      p += take.length;
    } else if (p < positionals.length) args[spec.name] = positionals[p++];
    else if (spec.nargs === "?") args[spec.name] = null;
    else missing.push(spec.name);
  }
  for (const [k, o] of Object.entries(options))
    if (o.required && !seen.has(k)) missing.push("--" + k);
  if (missing.length)
    throw new UsageError(`the following arguments are required: ${missing.join(", ")}`);
  if (p < positionals.length)
    throw new UsageError(`unrecognized arguments: ${positionals.slice(p).join(" ")}`);
  return [command, args as A];
}

/** Run a program with Python-compatible exit codes: 2 usage, 1 for `errors`, ExitCode as given. */
export function runProgram<A>(
  program: Program<A>,
  argv: string[],
  errors: (new (...a: any[]) => Error)[],
): number {
  let command: Command<A>;
  let args: A;
  try {
    [command, args] = parseArgs(program, argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(
      `usage: ${program.prog} {${Object.keys(program.commands).join(",")}} ...\n${program.prog}: error: ${e.message}\n`,
    );
    return 2;
  }
  try {
    command.run(args);
  } catch (e) {
    if (e instanceof ExitCode) return e.code;
    if (errors.some((cls) => e instanceof cls)) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }
  return 0;
}
