/**
 * Append every live Jev exchange (request sent, response received, cost and timing) to a local JSONL file, as fine-tuning data.
 * One file per process, so parallel runs never interleave lines.
 * Directory: JEV_LOG_DIR, default ~/.jev-logs; JEV_LOG_DIR=off disables. A failed write warns once and never fails the run.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { JevClient } from "../core/client.ts";

export function logExchanges(client: Pick<JevClient, "on" | "isLive">, dir = process.env.JEV_LOG_DIR ?? join(homedir(), ".jev-logs")): string | null {
  if (dir === "off" || !client.isLive) return null; // mock answers are not training data
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`);
  const tool = basename(process.argv[1] ?? "unknown");
  let failed = false;
  client.on((event) => {
    if (event.kind !== "response" || failed) return;
    const { raw, meta } = event.result;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), tool, request: raw.request, response: raw.response, meta }) + "\n");
    } catch (err: any) {
      failed = true;
      console.error(`jev log: ${err?.message ?? err}; not logging this run`);
    }
  });
  return file;
}
