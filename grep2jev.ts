/**
 * grep2jev: which of these files matter for a request? One Jev Noul per file, in parallel.
 * Code reads the files and sends them to Jev. Only paths and scores come back.
 * Python files go as AST skeletons (signatures and docstrings, no bodies); --full sends them whole.
 * --outline (experimental) sends every language as shallow lines plus lines near request terms, instead of skeletons.
 * Scores within --margin of the threshold are uncertain. A reduced file that lands there is rescored whole, and that score stands.
 *
 *   rg -l proration | node grep2jev.ts "the proration test fails because of rounding"
 *   node grep2jev.ts "request" src/a.ts src/b.ts --threshold 0.3
 *   rg -l client | node grep2jev.ts --task owner "the client registry"   # only files mainly about it (--primary is an alias)
 *   rg -l -i 'timeout|retry' | node grep2jev.ts --task bug "requests hang after the third retry"
 *   node grep2jev.ts "where invoices are rounded" src/billing           # a directory: every file below it
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { jev } from "./core/client.ts";
import { noul } from "./core/helpers.ts";
import type { NoulAnswer, Questions, State } from "./core/types.ts";
import { FileStateError, readFileState, type FileState } from "./lib/read-state.ts";
import { expandPatterns, pruneFiles, type Skipped } from "./lib/prune.ts";
import { logExchanges } from "./lib/log.ts";
import { outline as outlineOf, requestTerms } from "./lib/outline.ts";
import { pythonSkeletons } from "./lib/skeleton.ts";

export const QUESTIONS = {
  relevant: noul("Would someone working on `request` need to read or change the file at `path`, given its `content`?", {
    true: "The file implements, configures, tests, or directly calls the code the request is about",
    false: "Unrelated, or mentions the topic only in passing: a comment, a string, a changelog line",
  }),
};

/** --primary: only files whose main job is the topic. Files that just use it score low. */
export const PRIMARY_QUESTIONS = {
  relevant: noul("Is the file at `path` mainly about `request`, given its `content`?", {
    true: "The file's main job is the topic: it defines, implements, validates, or tests it, or is its data or setup",
    false: "The file's main job is something else; it only uses, imports, calls, or mentions the topic",
  }),
};

/** --task bug: where the cause of a failure, or the failing code, may be. */
export const BUG_QUESTIONS = {
  relevant: noul("Could the cause of the failure in `request`, or the code that fails, be in the file at `path`, given its `content`?", {
    true: "The file defines or runs the failing behavior, its inputs or config, or is the failing test",
    false: "The file is not on the failing path",
  }),
};

/** --task change: what a change touches. Callers and tests count, unlike --task owner. */
export const CHANGE_QUESTIONS = {
  relevant: noul("Would the file at `path` have to change, or could it break, if the change in `request` is made, given its `content`?", {
    true: "The file defines, calls, imports, overrides, configures, or tests the code being changed",
    false: "The file does not touch the code being changed",
  }),
};

/** --task tests: the tests and fixtures for a behavior. */
export const TESTS_QUESTIONS = {
  relevant: noul("Does the file at `path` test the behavior in `request`, given its `content`?", {
    true: "The file is a test or fixture that exercises the behavior",
    false: "The file is not a test, or tests something else",
  }),
};

/** Which question a run asks. The agent picks; no task means the general relevance question. */
export const TASKS = { owner: PRIMARY_QUESTIONS, bug: BUG_QUESTIONS, change: CHANGE_QUESTIONS, tests: TESTS_QUESTIONS };
export type Task = keyof typeof TASKS;

/** Low on purpose: a file judged alone can look less relevant than it is. */
export const DEFAULT_THRESHOLD = 0.4;
/**
 * Half-width of the uncertain band. 0 disables the band and rescoring.
 * Measured 2026-10-14 on ailab-rag (75 files x 5 runs, default question, full content): a run's distance from its file's median was p99 0.06, max 0.07.
 * 0.10 was the smallest margin where no score outside the band had a run on the other side of 0.4.
 * Same check per --task: bug max 0.05, tests 0.09, change 0.09 (noisiest); 0.10 had no misses for any. Skeletons were not measured.
 */
export const DEFAULT_MARGIN = 0.1;

/** Inside [threshold - margin, threshold + margin): the score cannot tell relevant from not. */
export const uncertain = (noul: number, threshold: number, margin: number) =>
  noul >= round(threshold - margin) && noul < round(threshold + margin);
/** Band edges in float arithmetic: 0.4 - 0.1 is 0.30000000000000004, which would push a 0.30 score out of the band. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export type Decide = (state: State, questions: Questions) => Promise<{ answers: Record<string, unknown> }>;

export interface Scored {
  path: string;
  noul: number;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function parallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function grep2jev(
  request: string,
  paths: string[],
  cwd: string,
  { decide = (s, q) => jev.systemOne(s, q), concurrency = 16, task, full = false, outline = false, threshold = DEFAULT_THRESHOLD, margin = DEFAULT_MARGIN }:
    { decide?: Decide; concurrency?: number; task?: Task; full?: boolean; outline?: boolean; threshold?: number; margin?: number } = {},
): Promise<{ scored: Scored[]; skipped: Skipped[] }> {
  const questions = task ? TASKS[task] : QUESTIONS;
  const { files, skipped } = await pruneFiles(paths, cwd);
  const states: FileState[] = [];
  for (const path of files) {
    try {
      states.push(await readFileState(path, cwd));
    } catch (err: any) {
      skipped.push({ path, reason: err instanceof FileStateError ? err.message : String(err?.message ?? err) });
    }
  }
  const terms = requestTerms(request);
  const reduced: Record<string, string> = full ? {}
    : outline ? Object.fromEntries(states.map((s) => [s.path, outlineOf(s.content, terms)]))
    : pythonSkeletons(states);
  const scored: Scored[] = [];
  await parallel(states, concurrency, async ({ path, content }) => {
    try {
      const score = async (sent: string) => ((await decide({ request, path, content: sent }, questions)).answers.relevant as NoulAnswer).noul;
      const sent = reduced[path] ?? content;
      let noul = await score(sent);
      // The reduction may have cut the evidence that decides a borderline file: judge it whole.
      if (sent !== content && uncertain(noul, threshold, margin)) noul = await score(content);
      scored.push({ path, noul });
    } catch (err: any) {
      skipped.push({ path, reason: `call failed: ${err?.message ?? err}` });
    }
  });
  scored.sort((a, b) => b.noul - a.noul || a.path.localeCompare(b.path));
  return { scored, skipped };
}

/** Precedence: shell, then .env next to this file, then ~/.jev_key (readable inside the agent sandbox, .env is not). */
export function loadEnv() {
  for (const file of [fileURLToPath(new URL(".env", import.meta.url)), join(homedir(), ".jev_key")]) {
    try { process.loadEnvFile(file); } catch { /* missing or unreadable: try the next */ }
  }
}

/** Paths from the arguments, else one per line from piped stdin. Deduplicated. */
export async function readPaths(args: string[]): Promise<string[]> {
  let paths = args;
  if (!paths.length && !process.stdin.isTTY) {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    paths = text.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  if (!paths.length) throw new Error("no paths: pipe a file list in or pass paths as arguments");
  return [...new Set(paths)];
}

async function main() {
  loadEnv();

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { threshold: { type: "string" }, margin: { type: "string" }, task: { type: "string" }, primary: { type: "boolean" }, full: { type: "boolean" }, outline: { type: "boolean" } },
  });
  const [request, ...args] = positionals;
  const threshold = values.threshold === undefined ? DEFAULT_THRESHOLD : Number(values.threshold);
  if (values.primary && values.task && values.task !== "owner") throw new Error("--primary is --task owner; pass one task");
  const task = values.primary ? "owner" : values.task;
  if (task !== undefined && !(task in TASKS)) throw new Error(`unknown --task ${task}; one of: ${Object.keys(TASKS).join(", ")}`);
  const margin = values.margin === undefined ? DEFAULT_MARGIN : Number(values.margin);
  if (!request?.trim() || !(threshold >= 0 && threshold <= 1) || !(margin >= 0 && margin <= 1) || (values.full && values.outline)) {
    throw new Error('usage: rg -l <pattern> | node grep2jev.ts "<request>" [paths, dirs, globs...] [--threshold 0..1] [--margin 0..1] [--task owner|bug|change|tests] [--full | --outline]');
  }
  const paths = await expandPatterns(await readPaths(args), process.cwd(), true);

  jev.provider; // construct the client now: missing credentials fail once, not once per file
  logExchanges(jev);
  const { scored, skipped } = await grep2jev(request, paths, process.cwd(), { task: task as Task | undefined, full: values.full, outline: values.outline, threshold, margin });

  const [low, high] = [threshold - margin, threshold + margin].map((n) => +Math.min(1, Math.max(0, n)).toFixed(2));
  const relevant = scored.filter((s) => s.noul >= high);
  const unsure = scored.filter((s) => uncertain(s.noul, threshold, margin));
  console.log(`relevant${task ? ` (task ${task})` : ""} (>= ${high}): ${relevant.length} of ${scored.length}`);
  for (const s of relevant) console.log(`${s.noul.toFixed(2)} ${s.path}`);
  if (unsure.length) console.log(`uncertain (${low} to ${high}): ${unsure.length}`);
  for (const s of unsure) console.log(`${s.noul.toFixed(2)} ${s.path}`);
  const top = scored[relevant.length + unsure.length];
  if (top) console.log(`not relevant: ${scored.length - relevant.length - unsure.length}, highest ${top.noul.toFixed(2)} ${top.path}`);
  for (const s of skipped.slice(0, 10)) console.log(`skipped: ${s.path} (${s.reason})`);
  if (skipped.length > 10) console.log(`skipped: ${skipped.length - 10} more`);
  // Failed calls mean unscored files: the result is incomplete, so the exit status says so.
  const failed = skipped.filter((s) => s.reason.startsWith("call failed")).length;
  if (failed) {
    console.error(`grep2jev: ${failed} of ${failed + scored.length} calls failed; results are incomplete`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`grep2jev: ${err?.message ?? err}`);
    process.exit(1);
  });
}
