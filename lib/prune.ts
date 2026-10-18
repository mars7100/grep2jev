/**
 * Level 9, option B: expand and prune.
 * Globs and directories become a file list in code. Dependencies, VCS folders, binaries, and files over the budget drop out with a reason. Over 255 candidates the run fails before any call is made.
 */
import { glob, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_FILE_CHARS } from "./read-state.ts";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".sessions", "dist", "build", "coverage", ".pi",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".next", ".nuxt", ".turbo", "target",
]);
/** Lock files, minified bundles, and source maps: machine written, never what a request is about. */
export const GENERATED_FILE =
  /(^|[/\\])(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum)$|\.(lock|lockb|min\.js|min\.css|map)$/i;
/** Policy, not an API limit: each file is its own Noul call, so this only bounds cost per run. */
export const MAX_CANDIDATE_FILES = 255;
const GLOB_CHARS = /[*?[\]{}]/;

export interface Skipped {
  path: string;
  reason: string;
}

const outside = (rel: string) => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
const skipDir = (d: Dirent) => d.isDirectory() && SKIP_DIRS.has(d.name);

/**
 * Patterns are files, directories, or globs. A directory means its files, or everything below it when recursive.
 * An existing path is taken literally before glob syntax is considered, so `app/[id].tsx` stays one file.
 * Only files come out; skipped directories are never walked.
 */
export async function expandPatterns(patterns: string[], cwd: string, recursive: boolean): Promise<string[]> {
  const out = new Set<string>();
  const walk = async (pattern: string, base: string, prefix: string) => {
    for await (const d of glob(pattern, { cwd: base, withFileTypes: true, exclude: skipDir }))
      if (!d.isDirectory()) out.add(join(prefix, relative(base, join(d.parentPath, d.name))));
  };
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const full = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
    let info;
    try { info = await stat(full); } catch {
      if (GLOB_CHARS.test(pattern)) await walk(pattern, cwd, "");
      else out.add(pattern); // let prune report it
      continue;
    }
    // A directory outside the repo is not walked; prune reports it once.
    if (info.isFile() || outside(relative(cwd, full))) { out.add(pattern); continue; }
    await walk(recursive ? "**/*" : "*", full, pattern);
  }
  return [...out].sort();
}

/** What survives, and why each dropped file dropped. Nothing here calls Jev. */
export async function pruneFiles(paths: string[], cwd: string, cap = MAX_CANDIDATE_FILES): Promise<{ files: string[]; skipped: Skipped[] }> {
  const files: string[] = [];
  const skipped: Skipped[] = [];
  const root = await realpath(cwd);
  for (const path of paths) {
    const full = isAbsolute(path) ? path : resolve(cwd, path);
    const rel = relative(cwd, full);
    if (outside(rel)) { skipped.push({ path, reason: "outside the repo" }); continue; }
    if (rel.split(sep).some((part) => SKIP_DIRS.has(part))) { skipped.push({ path, reason: "skipped directory" }); continue; }
    let info, real;
    try { [info, real] = await Promise.all([stat(full), realpath(full)]); } catch { skipped.push({ path, reason: "not found" }); continue; }
    // Symlinks resolve before the check: a link inside the repo must not send a file from outside it.
    if (outside(relative(root, real))) { skipped.push({ path, reason: "symlink outside the repo" }); continue; }
    if (!info.isFile()) { skipped.push({ path, reason: "not a file" }); continue; }
    if (info.size === 0) { skipped.push({ path, reason: "empty" }); continue; }
    if (info.size > MAX_FILE_CHARS) { skipped.push({ path, reason: `too large, ${info.size} bytes` }); continue; }
    if (GENERATED_FILE.test(path)) { skipped.push({ path, reason: "generated or lock file" }); continue; }
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|mov)$/i.test(path)) { skipped.push({ path, reason: "binary file" }); continue; }
    files.push(path);
  }
  // Over the cap means the scope is wrong, not that the run should be cut short: refuse before any call.
  if (files.length > cap) throw new Error(`${files.length} candidate files after pruning, the cap is ${cap}; narrow with rg or a subdirectory`);
  return { files, skipped };
}
