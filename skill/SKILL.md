---
name: grep2jev
description: Triage a large candidate file list with Jev before reading it. Use when a search (rg, grep, Grep, find) returns more files than you would read in full, roughly more than 5, while locating where a bug lives, which files a change touches, or what implements a feature.
---

# grep2jev

Jev (a cheap hosted judge) reads each candidate file and scores how relevant it is to your request, so you read only the files that pass. File contents go to Jev, not into your context. Cost is about $0.0002 per file. With 5 or fewer candidates, or when you already know the file, read directly.

## Steps

1. **The candidate list is the main lever on quality.** Jev scores only the files you send, each one judged alone. A file `rg` misses never reaches Jev, and every unrelated file is noise and cost.
   - Build the pattern from the task: identifiers from the error or stack trace, the names of functions and config keys involved, and their synonyms. Use alternation, case-insensitive: `rg -l -i 'prorat|rounding|invoice_total'`.
   - Scope by location when you know it: `rg -l -i '...' src/billing`. Pass a bare directory (no `rg`) only when you know where to look but not what to search for, and the directory is small.
   - Count before you send: `rg -l ... | wc -l`. Aim for tens. Large counts mean the pattern is too broad: add a term or a directory. Over 255 candidates after pruning fails before any call.
   - Leave out files you already know are relevant; read them directly.
2. **Run it from the repo root, with the request written as the task in plain words** (the bug report or the change you are making, not the grep pattern):
   ```sh
   rg -l -i 'prorat|rounding' | node ~/Projects/grep2jev/grep2jev.ts "the proration test fails because of rounding"
   ```
   - `--task` picks the question Jev answers. Pick from the task you are doing; without it Jev asks whether someone working on the request would read or change the file.
     - `bug`: where the cause of a failure, or the failing code, may be.
     - `change`: files that must change or could break, callers and tests included.
     - `tests`: tests and fixtures that exercise the behavior.
     - `owner` (alias `--primary`): files that define or own the topic, not every caller and user.
   - `--full`: the request is about Python test behavior. By default Python files go as skeletons (signatures and docstrings, no bodies), and test files lose most of their evidence that way. Skeletons that score in the uncertain band are already rescored whole.
   - `--threshold 0.3`: widen when the request is broad or few files pass.
   - `--margin`: half-width of the uncertain band around the threshold, default 0.10. `--margin 0` gives a single cutoff.
3. **Read the `relevant` files, highest score first.** Then the `uncertain` ones: their scores are within Jev's noise of the threshold, so the score alone cannot rule them in or out. The line `not relevant: N, highest 0.xx path` names the best file below the band.
4. **Done when the files you read explain the task.** Fall back to your own `rg` and reading when:
   - nothing passes;
   - the passing files do not explain the task;
   - the answer depends on callers or wiring across files: each file is judged alone, so a file that matters only through its callers can score low.

## Environment

- Network: the call goes to `openrouter.ai`. Node's `fetch` reaches it through the sandbox proxy only with `NODE_USE_ENV_PROXY=1`. `call failed: fetch failed` on every file means that variable is missing: prefix the command with `NODE_USE_ENV_PROXY=1`.
- Every live call is logged to `~/.jev-logs`. `JEV_LOG_DIR=off` disables logging for a run. A `jev log:` warning means the log could not be written; the results are still valid.
- Exit status 1 with `N of M calls failed; results are incomplete` means some files were never scored: rerun, or read the failed files yourself.
- Credential files (`.env`, `*.pem`, `id_rsa`, ...) are never sent, nor are files containing known key formats (private keys, `sk-`, `AKIA`, `ghp_`, ...); they show as skipped. A free-form secret like `password = "..."` is sent.
