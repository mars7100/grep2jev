# grep2jev

A CLI that lets a coding agent hand file triage to [Jev](https://typesafe.ai) instead of reading files into its own context: you pipe in candidate files, Jev scores each one against the request in parallel, and the agent reads only the files that pass.

`core/` and `lib/` are copied from [disler/ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev) (MIT, see `LICENSE`): the client, wire types, mock, file reader, and pruning.

## Setup

Node 24+. No dependencies. Copy `.env.example` to `.env` or `~/.jev_key` and set a key, or export it in your shell. Precedence: shell, then `.env`, then `~/.jev_key`. Use `~/.jev_key` when an agent runs the CLIs: Claude Code's sandbox refuses to read `.env` files. With no key the CLIs fail closed. `JEV_BACKEND=mock` runs the offline mock, which checks wiring only: it scores by word overlap.

```sh
npm test
```

## grep2jev

Which of these files matter for a request? One Noul per file: would someone working on the request need to read or change it?

```sh
rg -l proration | node grep2jev.ts "the proration test fails because of rounding"
node grep2jev.ts "request" src/a.ts src/b.ts --threshold 0.3
node grep2jev.ts "where invoices are rounded" src/billing      # a directory or glob: every file below it
rg -l client | node grep2jev.ts --task owner "the client registry"
```

Arguments can be files, directories (recursive), or globs; piped paths go through the same expansion. An existing path is taken literally, so `app/[id].tsx` is one file.

Python files are sent as AST skeletons by default: imports, module code, signatures, and docstrings, with function bodies dropped (python3's stdlib `ast`, no install). Other languages, and Python that does not parse, are sent whole. `--full` sends every file whole. A skeleton that scores in the uncertain band is rescored whole, and the whole score stands. On ailab-rag (76 files, `--primary`) the skeleton cut input tokens by 34% and kept the same top three; only `--primary` was compared, and repos with few docstrings give Jev less to judge.

One question per call, picked by `--task` (the agent chooses):

- no task: would someone working on the request need to read or change this file? Callers and users of the topic score medium.
- `bug`: could the cause of the failure, or the failing code, be in this file?
- `change`: would this file have to change, or could it break, if the change is made? Callers and tests count.
- `tests`: does this file test the behavior?
- `owner` (alias `--primary`): is this file mainly about the request? Only files that define, implement, validate, or test the topic, or hold its data or setup, score high.

Every task uses the same threshold and margin; neither is calibrated per task yet.

Output shape (illustrative numbers):

```
relevant (task bug) (>= 0.5): 2 of 17
0.96 src/domain/billing.ts
0.93 tests/proration.test.ts
uncertain (0.3 to 0.5): 1
0.41 src/domain/invoice.ts
not relevant: 14, highest 0.21 src/domain/plans.ts
skipped: node_modules/x.js (skipped directory)
```

- Recall is capped by the list. A file grep misses never reaches Jev. A broader pattern costs little.
- Each file is judged alone. A file that matters only through its callers can score low. The 0.4 default leaves margin.
- Scores within `--margin` (default 0.10: on ailab-rag, 75 files x 5 runs, a single score sat within 0.07 of its file's median, and 0.10 was the smallest margin with no confident score contradicted by another run; it also held for `bug`, `change` and `tests`, where `change` was noisiest at 0.09) of the threshold are listed as uncertain. `--margin 0` gives a single cutoff.
- Exits 1 when any Jev call fails: the results print, but those files were never scored.
- Never sends credential files, matched by name: `.env*`, `*.env`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `credentials*`, `.jev_key`, and similar. Also skips files whose content holds a known key format: PEM private keys with key data, `sk-`, `AKIA`, `ghp_`/`github_pat_`, Stripe live keys, Slack `xox*-`, Google `AIza`. A free-form secret like `password = "..."` is still sent.
- Drops dependency, build, and cache folders (`node_modules`, `.git`, `dist`, `__pycache__`, `.venv`, `.next`, `target`, ...), lock files (`*.lock`, `package-lock.json`, `pnpm-lock.yaml`, `go.sum`), minified bundles and source maps, binaries, empty files, and files over ~240k chars. More than 255 candidates after pruning fails before any call; narrow with rg or a subdirectory. Paths outside the cwd, and symlinks pointing outside it, are skipped.
- File contents are sent to the Jev provider.

### Exchange logs

Every live Jev call from `grep2jev` appends one JSON line to `~/.jev-logs/<start time>-<pid>.jsonl`: the request sent (state and questions), the raw response, and meta (resolved model version, cost, time). Kept as fine-tuning data. File contents are in the log; credential files never are, but a key hardcoded in a normal file is. `JEV_LOG_DIR` moves it, `JEV_LOG_DIR=off` disables it, and mock runs are not logged. Claude Code's sandbox blocks writes to `~/.jev-logs` unless it is on the sandbox's write allowlist; the run continues with a one-line warning.

## Claude Code skill

`skill/SKILL.md` tells an agent when and how to run grep2jev. Install it with `cp -r skill ~/.claude/skills/grep2jev`. It assumes the repo is cloned to `~/Projects/grep2jev`, so edit the path in step 2 if you cloned it somewhere else.
