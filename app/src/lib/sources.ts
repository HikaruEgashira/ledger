// Work-tool connectors: each skills/sources/<name>/SOURCE.md declares how its URLs map to task ids; the body tells workers how to use its MCP server.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cardRef, sourceKey as keyOf, type SourceRule } from "../../webui/sourcekey.ts";

export { cardRef };
export interface SourceDef extends SourceRule {
  description: string;
  /** MCP server whose tools reach the tool. */
  mcp: string;
  /** SOURCE.md path, for worker prompts. */
  path: string;
}

const DIR = resolve(import.meta.dir, "../../../skills/sources");

export function parseSource(text: string, path = ""): SourceDef {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error(`missing front matter: ${path}`);
  const d = Bun.YAML.parse(m[1]!) as Partial<SourceDef>;
  if (!d.name || !/^[a-z][a-z0-9-]*$/.test(d.name)) throw new Error(`invalid source name: ${path}`);
  if (!d.mcp || !d.hosts?.length || !d.urls?.length) throw new Error(`source ${d.name} needs mcp, hosts and urls`);
  for (const u of d.urls) new RegExp(u.match);
  return { description: "", ...d, path } as SourceDef;
}

let cache: SourceDef[] | null = null;
export function loadSources(dir = DIR): SourceDef[] {
  if (dir === DIR && cache) return cache;
  const out = existsSync(dir)
    ? readdirSync(dir).filter((n) => existsSync(join(dir, n, "SOURCE.md"))).sort().map((n) => parseSource(readFileSync(join(dir, n, "SOURCE.md"), "utf8"), join(dir, n, "SOURCE.md")))
    : [];
  if (dir === DIR) cache = out;
  return out;
}

/** Url rules only: what the browser needs to key and label links. */
export const sourceRules = (): SourceRule[] => loadSources().map(({ name, hosts, urls, id, record }) => ({ name, hosts, urls, id, record }));

export const sourceKey = (url: string, sources: SourceRule[] = loadSources()) => keyOf(url, sources);
export const sourceOf = (id: string, sources: SourceDef[] = loadSources()) => sources.find((s) => id.startsWith(s.name + ":"));
