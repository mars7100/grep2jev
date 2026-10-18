/**
 * AST skeletons for Python files: imports, signatures, and docstrings, no function bodies.
 * About a third fewer tokens per run with the same ranking in the ailab-rag comparison (2026-10-14).
 * ponytail: Python only, via python3's stdlib ast. Other languages are sent in full; ast-grep if they matter.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FileState } from "./read-state.ts";

const SCRIPT = fileURLToPath(new URL("./skeleton.py", import.meta.url));

/** Skeletons keyed by path. A file missing from the result is sent in full. */
export function pythonSkeletons(files: FileState[]): Record<string, string> {
  const py = files.filter((f) => f.path.endsWith(".py"));
  if (!py.length) return {};
  try {
    const input = JSON.stringify(Object.fromEntries(py.map((f) => [f.path, f.content])));
    return JSON.parse(execFileSync("python3", ["-I", SCRIPT], { input, maxBuffer: 256 << 20 }).toString());
  } catch (err: any) {
    console.error(`skeleton: python3 failed (${err?.message ?? err}), sending full files`);
    return {};
  }
}
