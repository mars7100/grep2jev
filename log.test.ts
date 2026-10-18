import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { logExchanges } from "./lib/log.ts";

const fakeClient = (isLive: boolean) => {
  const listeners: ((e: any) => void)[] = [];
  return { isLive, on: (l: any) => (listeners.push(l), () => {}), emit: (e: any) => listeners.forEach((l) => l(e)) };
};
const response = (n: number) => ({ kind: "response", result: { raw: { request: { state: { n } }, response: { answers: { n } } }, meta: { cost: { amount: 0.001 } } } });

test("live responses are appended one line each; requests and mock clients are not logged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jevlog-"));
  const client = fakeClient(true);
  const file = logExchanges(client, dir)!;
  client.emit({ kind: "request" });
  client.emit(response(1));
  client.emit(response(2));
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.request.state.n, l.response.answers.n, l.meta.cost.amount]), [[1, 1, 0.001], [2, 2, 0.001]]);
  assert.equal(logExchanges(fakeClient(false), dir), null);
  assert.equal(logExchanges(client, "off"), null);
});

test("a failed write warns and never throws", () => {
  const client = fakeClient(true);
  logExchanges(client, "/dev/null/cannot");
  assert.doesNotThrow(() => client.emit(response(1)));
});
