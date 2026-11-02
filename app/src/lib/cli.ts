// Declarative subcommand CLI on node:util parseArgs. Exit codes: 0 ok, 1 known error, 2 usage.
import { normalize } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { ExitCode } from "./util.ts";

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

class UsageError extends Error {}

const dest = (key: string) => key.replace(/-/g, "_");
const normalizePath = (raw: string) => (raw ? normalize(raw).replace(/(.)\/+$/, "$1") : ".");

function parseSection(
  tokens: string[],
  options: Record<string, Opt>,
  args: Record<string, any>,
  allowPositionals: boolean,
): string[] {
  const config: ParseArgsConfig["options"] = {};
  for (const [key, opt] of Object.entries(options))
    config[key] = { type: opt.kind === "flag" ? "boolean" : "string", multiple: opt.kind === "append" };
  let parsed;
  try {
    parsed = parseArgs({ args: tokens, options: config, allowPositionals, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  for (const [key, opt] of Object.entries(options)) {
    const raw = (parsed.values as Record<string, any>)[key];
    if (raw === undefined) {
      if (opt.required) throw new UsageError(`the following arguments are required: --${key}`);
      args[dest(key)] = opt.kind === "flag" ? false : opt.kind === "append" ? null : (opt.default ?? null);
      continue;
    }
    for (const v of opt.kind === "append" ? raw : opt.kind === "flag" ? [] : [raw])
      if (opt.choices && !opt.choices.includes(v))
        throw new UsageError(`argument --${key}: invalid choice: '${v}' (choose from ${opt.choices.join(", ")})`);
    if (opt.kind === "int") {
      if (!/^\s*[-+]?\d+\s*$/.test(raw)) throw new UsageError(`argument --${key}: invalid int value: '${raw}'`);
      args[dest(key)] = Number.parseInt(raw, 10);
    } else args[dest(key)] = opt.kind === "path" ? normalizePath(raw) : raw;
  }
  return parsed.positionals;
}

/** Index of the subcommand: first token that is neither a global option nor its value. */
function commandIndex(argv: string[], globals: Record<string, Opt>): number {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) return i;
    const opt = globals[t.slice(2)];
    if (opt && opt.kind !== "flag") i++;
  }
  return argv.length;
}

function parse<A>(program: Program<A>, argv: string[]): [Command<A>, A] {
  const args: Record<string, any> = {};
  const globals = program.globals ?? {};
  const at = commandIndex(argv, globals);
  parseSection(argv.slice(0, at), globals, args, false);
  const name = argv[at];
  if (name === undefined) throw new UsageError("the following arguments are required: command");
  const command = program.commands[name];
  if (!command)
    throw new UsageError(`invalid command: '${name}' (choose from ${Object.keys(program.commands).join(", ")})`);
  const positionals = parseSection(argv.slice(at + 1), command.options ?? {}, args, true);
  const specs = command.positionals ?? [];
  const missing: string[] = [];
  let p = 0;
  specs.forEach((spec, idx) => {
    if (spec.nargs === "+") {
      const take = positionals.slice(p, positionals.length - (specs.length - idx - 1));
      if (!take.length) missing.push(spec.name);
      args[spec.name] = take;
      p += take.length;
    } else if (p < positionals.length) args[spec.name] = positionals[p++];
    else if (spec.nargs === "?") args[spec.name] = null;
    else missing.push(spec.name);
  });
  if (missing.length) throw new UsageError(`the following arguments are required: ${missing.join(", ")}`);
  if (p < positionals.length) throw new UsageError(`unrecognized arguments: ${positionals.slice(p).join(" ")}`);
  return [command, args as A];
}

const usage = (program: Program<unknown>) =>
  `usage: ${program.prog} [--${Object.keys(program.globals ?? {}).join(" --")}] {${Object.keys(program.commands).join(",")}} ...\n`;

export function runProgram<A>(
  program: Program<A>,
  argv: string[],
  errors: (new (...a: any[]) => Error)[],
): number {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(usage(program as Program<unknown>));
    return 0;
  }
  let command: Command<A>;
  let args: A;
  try {
    [command, args] = parse(program, argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${usage(program as Program<unknown>)}${program.prog}: error: ${e.message}\n`);
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
