// URL → item key for work-tool connectors; pure so the server and the browser share it. Definitions come from skills/sources/*/SOURCE.md.
export interface UrlRule {
  /** Regex on the URL with named groups `scope` and `key` (or groups referenced by `key`). */
  match: string;
  /** Key template from named groups, e.g. "{s}.{us}"; defaults to the `key` group. */
  key?: string;
}
export interface SourceRule {
  name: string;
  /** Hosts an item URL may live on (suffix match). */
  hosts: string[];
  urls: UrlRule[];
  /** Id template after `<name>:`; defaults to "{scope}:{key}". */
  id?: string;
  /** System of record: leads a group over conversation sources. */
  record?: boolean;
}

const fill = (t: string, g: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k) => g[k] ?? "");

/** `<source>:<id>` of a URL under the first source whose host and rule match; null for other URLs. */
export function sourceKey(url: string, sources: SourceRule[]): string | null {
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  for (const s of sources) {
    if (!s.hosts.some((h) => host === h || host.endsWith("." + h))) continue;
    for (const r of s.urls) {
      const g = new RegExp(r.match).exec(url)?.groups;
      if (!g?.scope) continue;
      const key = r.key ? fill(r.key, g) : g.key;
      if (key) return `${s.name}:${fill(s.id ?? "{scope}:{key}", { ...g, key })}`;
    }
  }
  return null;
}

/** Board placement: <source>/<scope> and a number when the key is one (an issue number), else 0. */
export function cardRef(id: string): { repository: string; number: number } {
  const name = id.slice(0, id.indexOf(":"));
  const rest = id.slice(id.indexOf(":") + 1);
  const n = /^(.*?)[-:](\d+)$/.exec(rest);
  return n ? { repository: `${name}/${n[1]}`, number: Number(n[2]) } : { repository: `${name}/${rest.split(":")[0]}`, number: 0 };
}

/** Short label of a source item: the issue key when it has one, else <source>/<scope>. */
export function keyLabel(id: string): string {
  const { repository, number } = cardRef(id);
  return number ? `${repository.slice(repository.indexOf("/") + 1)}-${number}` : repository;
}
