import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONFIG_TOML = join(resolve(import.meta.dir, "../../.."), "config/config.toml");

// Machine / organization specific settings (config/config.toml, gitignored).
export function localConfig(path = CONFIG_TOML): Record<string, any> {
  return existsSync(path) ? Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, any> : {};
}

let cached: string | undefined;

// GitHub org this workspace is restricted to: $REVIEW_ORG, else org in config.toml.
export function org(): string {
  if (cached) return cached;
  const value = process.env.REVIEW_ORG || localConfig().org;
  if (typeof value !== "string" || !/^[A-Za-z0-9-]+$/.test(value))
    throw new Error(`GitHub org is not configured: set REVIEW_ORG or org in ${CONFIG_TOML}`);
  return (cached = value);
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
