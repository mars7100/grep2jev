import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { grep2jev, PRIMARY_QUESTIONS, QUESTIONS, TASKS, type Decide, type Task } from "./grep2jev.ts";
import { expandPatterns, pruneFiles } from "./lib/prune.ts";

test("scores each readable file, sorts by relevance, skips the rest with a reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grep2jev-"));
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "billing.ts"), "export const round = (x: number) => Math.round(x);");
  await writeFile(join(dir, "other.ts"), "export {};");
  await writeFile(join(dir, "readme.md"), "Billing docs.");
  await writeFile(join(dir, "logo.bin"), Buffer.from([1, 0, 2]));
  await writeFile(join(dir, "app.env"), "API_KEY=real");
  await writeFile(join(dir, "config.py"), `KEY = "sk-${"a".repeat(30)}"`);
  await writeFile(join(dir, "server.pem"), "-----BEGIN PRIVATE KEY-----");
  await writeFile(join(dir, "package-lock.json"), "{}");
  await writeFile(join(dir, "app.min.js"), "x");
  await writeFile(join(dir, "lockfile.ts"), "export {};");
  await writeFile(join(dir, "node_modules/dep.js"), "x");

  const seen: any[] = [];
  const decide: Decide = async (state: any) => {
    seen.push(state);
    if (state.path === "readme.md") throw new Error("boom");
    return { answers: { relevant: { type: "noul", noul: state.path === "billing.ts" ? 0.9 : 0.1 } } };
  };

  const { scored, skipped } = await grep2jev("fix rounding", ["other.ts", "billing.ts", "readme.md", "logo.bin", "app.env", "server.pem", "config.py", "package-lock.json", "app.min.js", "lockfile.ts", "node_modules/dep.js", "missing.ts"], dir, { decide });

  assert.deepEqual(scored, [{ path: "billing.ts", noul: 0.9 }, { path: "lockfile.ts", noul: 0.1 }, { path: "other.ts", noul: 0.1 }]);
  assert.equal(seen.find((s) => s.path === "billing.ts").request, "fix rounding");
  assert.match(seen.find((s) => s.path === "billing.ts").content, /Math.round/);
  const reasons = Object.fromEntries(skipped.map((s) => [s.path, s.reason]));
  assert.match(reasons["readme.md"], /call failed: boom/);
  assert.match(reasons["logo.bin"], /binary/);
  assert.match(reasons["app.env"], /secret file/);
  assert.match(reasons["server.pem"], /secret file/);
  assert.match(reasons["config.py"], /possible credential in content/);
  assert.ok(!seen.some((s) => ["app.env", "server.pem", "config.py"].includes(s.path)), "secret files never reach decide");
  assert.equal(reasons["package-lock.json"], "generated or lock file");
  assert.equal(reasons["app.min.js"], "generated or lock file");
  assert.equal(reasons["node_modules/dep.js"], "skipped directory");
  assert.equal(reasons["missing.ts"], "not found");
});

test("python files go as skeletons by default and whole with full", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grep2jev-"));
  await writeFile(join(dir, "mod.py"), 'import os\n\ndef load():\n    """Load the registry."""\n    body_marker = 1\n    return body_marker\n');
  await writeFile(join(dir, "broken.py"), "def (:\n    body_marker = 1\n");
  await writeFile(join(dir, "notes.md"), "body_marker");
  const sent: Record<string, string> = {};
  const decide: Decide = async (state: any) => {
    sent[state.path] = state.content;
    return { answers: { relevant: { type: "noul", noul: 0.9 } } };
  };

  await grep2jev("r", ["mod.py", "broken.py", "notes.md"], dir, { decide });
  assert.match(sent["mod.py"], /import os/);
  assert.match(sent["mod.py"], /def load\(\):/);
  assert.match(sent["mod.py"], /Load the registry\./);
  assert.doesNotMatch(sent["mod.py"], /body_marker/);
  assert.match(sent["broken.py"], /body_marker/, "a file that does not parse is sent whole");
  assert.equal(sent["notes.md"], "body_marker", "other languages are sent whole");

  await grep2jev("r", ["mod.py"], dir, { decide, full: true });
  assert.match(sent["mod.py"], /body_marker/);
});

test("each --task sends its own question; no task sends the relevance question", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grep2jev-"));
  await writeFile(join(dir, "a.ts"), "x");
  const sent: any[] = [];
  const decide: Decide = async (_state, questions) => {
    sent.push(questions);
    return { answers: { relevant: { type: "noul", noul: 0.5 } } };
  };
  await grep2jev("r", ["a.ts"], dir, { decide });
  for (const task of Object.keys(TASKS) as Task[]) await grep2jev("r", ["a.ts"], dir, { decide, task });
  assert.deepEqual(sent, [QUESTIONS, ...Object.values(TASKS)]);
  assert.equal(TASKS.owner, PRIMARY_QUESTIONS);
});

test("symlinks to files outside the repo are skipped; names starting with .. are not", async () => {
  const outside = await mkdtemp(join(tmpdir(), "grep2jev-out-"));
  await writeFile(join(outside, "secret.ts"), "x");
  const dir = await mkdtemp(join(tmpdir(), "grep2jev-"));
  await symlink(join(outside, "secret.ts"), join(dir, "link.ts"));
  await writeFile(join(dir, "..dots.ts"), "x");
  await writeFile(join(dir, "real.ts"), "x");
  await symlink(join(dir, "real.ts"), join(dir, "inside.ts"));

  const { files, skipped } = await pruneFiles(["link.ts", "..dots.ts", "inside.ts", "../x.ts"], dir);
  assert.deepEqual(files, ["..dots.ts", "inside.ts"]);
  assert.deepEqual(skipped, [{ path: "link.ts", reason: "symlink outside the repo" }, { path: "../x.ts", reason: "outside the repo" }]);
});

test("more files than the cap fails before any call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grep2jev-"));
  for (const f of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(dir, f), "x");
  await assert.rejects(pruneFiles(["a.ts", "b.ts", "c.ts"], dir, 2), /3 candidate files after pruning, the cap is 2/);
  assert.deepEqual((await pruneFiles(["a.ts", "b.ts"], dir, 2)).files, ["a.ts", "b.ts"]);
});

test("directories expand to their files, recursively, without walking skipped dirs; bracket names stay literal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grep2jev-"));
  await mkdir(join(dir, "src/deep"), { recursive: true });
  await mkdir(join(dir, "src/node_modules/pkg"), { recursive: true });
  await mkdir(join(dir, "app"));
  for (const f of ["src/a.ts", "src/deep/b.ts", "src/node_modules/pkg/c.js", "app/[id].tsx", "app/i.tsx"]) await writeFile(join(dir, f), "x");

  assert.deepEqual(await expandPatterns(["src/", "app/[id].tsx", "missing.ts"], dir, true), ["app/[id].tsx", "missing.ts", "src/a.ts", "src/deep/b.ts"]);
  assert.deepEqual(await expandPatterns(["src"], dir, false), ["src/a.ts"]);
  assert.deepEqual(await expandPatterns(["src/**/*.ts"], dir, true), ["src/a.ts", "src/deep/b.ts"]);
  assert.deepEqual((await pruneFiles(["src"], dir)).skipped, [{ path: "src", reason: "not a file" }]);
});

test("a reduced file scored in the uncertain band is rescored whole, and the whole score stands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grep2jev-"));
  for (const f of ["edge.py", "sure.py"]) await writeFile(join(dir, f), "def f():\n    body_marker = 1\n");
  await writeFile(join(dir, "edge.md"), "body_marker");
  const calls: string[] = [];
  const decide: Decide = async (state: any) => {
    const whole = /body_marker/.test(state.content);
    calls.push(`${state.path}:${whole ? "whole" : "skeleton"}`);
    const noul = state.path === "sure.py" ? 0.9 : whole && state.path === "edge.py" ? 0.8 : 0.45;
    return { answers: { relevant: { type: "noul", noul } } };
  };

  const { scored } = await grep2jev("r", ["edge.py", "sure.py", "edge.md"], dir, { decide, concurrency: 1 });
  assert.deepEqual(calls, ["edge.py:skeleton", "edge.py:whole", "sure.py:skeleton", "edge.md:whole"], "only the reduced borderline file is rescored");
  assert.deepEqual(scored, [{ path: "sure.py", noul: 0.9 }, { path: "edge.py", noul: 0.8 }, { path: "edge.md", noul: 0.45 }]);

  calls.length = 0;
  await grep2jev("r", ["edge.py"], dir, { decide, margin: 0 });
  assert.deepEqual(calls, ["edge.py:skeleton"], "margin 0 disables rescoring");
});

test("the content scan needs key material, not just a marker", async () => {
  const { SECRET_CONTENT } = await import("./lib/read-state.ts");
  assert.ok(!SECRET_CONTENT.test("-----BEGIN PRIVATE KEY-----"), "a bare PEM header in a fixture is sent");
  assert.ok(SECRET_CONTENT.test(`-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(64)}\n`));
  assert.ok(SECRET_CONTENT.test(`token = "ghp_${"a".repeat(36)}"`));
});

test("band edges are exact despite float arithmetic", async () => {
  const { uncertain } = await import("./grep2jev.ts");
  assert.ok(uncertain(0.3, 0.4, 0.1), "0.30 is the low edge, inside");
  assert.ok(!uncertain(0.5, 0.4, 0.1), "0.50 is the high edge, outside");
  assert.ok(!uncertain(0.4, 0.4, 0), "margin 0 has no band");
});
