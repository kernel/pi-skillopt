---
name: manual-testing
description: Playbook for running a manual, end-to-end test of the pi-skillopt plugin in a real pi session — drive the skillopt-create / taskpack / finalize skills against an example, watch the loop progress, and analyze the run. Use when asked to "manually test skillopt", "smoke-test the plugin", "run a skillopt session and see how it goes", or to reproduce/verify a reported skillopt behavior. Repo-local dev tooling — not shipped to plugin users.
---

# skillopt — manual testing playbook

This is for a **testing agent** (you), not for a plugin user. Your job: stand up a real `pi` session with the `pi-skillopt` plugin loaded, drive the skillopt skills end to end against one of the bundled examples, watch the optimization loop progress, and analyze the run for correctness. The skillopt skills are "just instructions an agent follows," so the only way to find UX gaps and wiring bugs is to actually run one.

The deliverable of a test run is a **report**: did the loop behave correctly, where did it get stuck or confuse, and which of the known failure signatures (below) showed up. Treat this like reproducing a bug report or doing a release smoke test.

---

## 0. The data you need before you can run a test

A test cannot start until these are in place. Check each, and if one is missing, either provision it or — if you can't (e.g. no API key on this box) — **stop and report exactly which prerequisite is blocking**, how far the preflight got, and what the user needs to supply. A half-run with a clear blocker is a useful result; a vague "it didn't work" is not.

Set `PLUGIN` to the checkout path first (used throughout): `PLUGIN=/home/agent/pi-skillopt` (adjust if yours differs).

| # | What | Why you need it | Check | If missing |
|---|------|-----------------|-------|------------|
| 1 | **The plugin checkout** | the thing under test | `ls "$PLUGIN/extensions/pi-skillopt/index.ts"` | `gh repo clone kernel/pi-skillopt` (this playbook lives inside it) |
| 2 | **`pi` CLI** | runs the session that loads the plugin | `command -v pi \|\| ls "$PLUGIN/node_modules/.bin/pi"` | **fast path: the repo bundles it** — `export PATH="$PLUGIN/node_modules/.bin:$PATH"` makes `pi` available. It's `@mariozechner/pi-coding-agent` (~0.65.x — the version the plugin is built against), **not** the unrelated `pi` on npm. A globally-installed `pi` works too if it's the same family. |
| 3 | **A model API key for pi itself** | pi needs a model to *drive* the session (read the skill, call the tools, reflect) | `[ -n "$ANTHROPIC_API_KEY" ] && echo set` | export a key for whatever model you'll point pi at (`--model`) |
| 4 | **A model key for the rollout agent** | the agent that runs *inside* each Harbor sandbox needs its provider key (for `claude-code` → `ANTHROPIC_API_KEY`) | same as #3 when both are Anthropic | export it; it gets injected via `rollout.setup.env` |
| 5 | **Harbor CLI** | `run_rollout` shells out to `harbor run --config` | `command -v harbor` | `uv tool install harbor` (add the backend extra for remote backends, e.g. `uv tool install 'harbor[e2b]'`) |
| 6 | **A rollout backend** | where each task actually runs | `docker` → `docker info`; `e2b` → `[ -n "$E2B_API_KEY" ]` | use `docker` (local, no key) for the simplest test; for `e2b` you need a **Pro-tier** key (hobby tier's 1h cap makes every rollout error) |
| 7 | **A fresh working directory** | a run writes all its state here; never run inside the repo or an example dir | `mkdir -p ~/skillopt-runs/run-$(date +%s)` | create one per run |

Keys #3 and #4 are the same `ANTHROPIC_API_KEY` when you drive pi with an Anthropic model **and** use the default `claude-code` rollout agent — but they play two distinct roles (driver vs. rollout agent), so name both when you report what's set.

**e2b blockers to expect** (these actually stop runs — and are *not* the hobby-tier `400: Timeout cannot be greater than 1 hours` cap, which a Pro key avoids):
- **`AgentSetupTimeoutError` after ~360s** — `claude-code` bootstraps Node/npm/curl *inside* the sandbox, and on a bare `ubuntu:24.04` base that blows the agent-setup timeout, erroring every trial. Mitigation: pre-bake `nodejs`/`npm`/`curl` into each task's `environment/Dockerfile` (then claude-code only `npm i`s itself), and/or raise the agent-setup timeout.
- **template build-then-use race** — `404: tag 'default' does not exist for template '<...>'` and `BuildException: build was cancelled`. Harbor builds N task templates concurrently then immediately creates sandboxes, racing e2b's tag publication; the per-rollout SIGTERM also cancels in-flight builds. Mitigation: pre-build/warm the templates before the run, lower `n_concurrent_trials`, and raise the per-rollout timeout. (This is a Harbor/e2b issue, not a pi-skillopt one — the plugin correctly reports these as "infra failure, not a skill failure".)

**Cheapest possible test:** `docker` backend + the `oracle` rollout agent on `examples/hello-harbor` needs **no model key at all** (oracle runs each task's `solution/solve.sh` instead of a model). It's meant to exercise the whole init → rollout → gate → finalize pipeline for free. **Verify it actually scores before relying on it:** a healthy oracle rollout returns `hard ~100%`. If instead every trial *errors* (you'll see `all N trial(s) errored … infra failure, not a skill failure`, often with agent `exit-code 127` / `RewardFileNotFoundError` in `skillopt.jobs/`), that's a Harbor/docker environment problem — the oracle agent step never ran — **not** the plugin or the skill. In that case fall back to a real agent + key, and flag the broken oracle separately. (The two no-pack examples don't ship `solution/` dirs, so oracle only applies to hello-harbor.)

---

## 1. Load the plugin

The plugin declares both an extension and the three skills in its `package.json` `pi` manifest. Two ways to get them into a session:

- **Faithful (mirrors how users run it):** `pi install "$PLUGIN"` — registers the package so the extension **and** all three `/skill:skillopt-*` commands load on every `pi` run in that (trusted) project. This is what a real user does.
- **Self-contained (no global settings mutation):** pass them on the command line every run. `-e <repo>` loads the extension via the manifest; **skills do not come along with `-e`**, so also pass each skill dir explicitly:

  ```bash
  PLUGIN=/home/agent/pi-skillopt
  pi -e "$PLUGIN" \
     --skill "$PLUGIN/skills/skillopt-create" \
     --skill "$PLUGIN/skills/skillopt-taskpack" \
     --skill "$PLUGIN/skills/skillopt-finalize" \
     <other flags>
  ```

`pi install <repo>` needs a globally-installed `pi`; with the bundled binary, prefer the self-contained form. (`-e` alone loads the extension but **not** the skills — confirmed against the loader — so the `--skill` flags are required if you want the `/skill:` commands.)

Verify the plugin loaded:
- **Interactive:** type `/skill:` and confirm `skillopt-create`, `skillopt-taskpack`, `skillopt-finalize` appear.
- **Non-interactive:** `pi --mode json -e "$PLUGIN" --skill "$PLUGIN/skills/skillopt-create" -p "list the skills and tools you have available" --thinking off < /dev/null` and grep the output for `skillopt`. (The `< /dev/null` matters — see Mode B.)

The extension contributes three tools — `init_optimization` (the entry point), `run_rollout`, `log_step`. They become active for the loop once `init_optimization` runs; `init_optimization` is what you call first.

---

## 2. Pick a test target

All three live under `$PLUGIN/examples/`. Choose based on what you want to exercise:

| Target | Ships a task pack? | What it tests | Use when |
|--------|--------------------|---------------|----------|
| `hello-harbor` | **yes** (6 tasks, with `solution/` dirs) | the full loop end to end, fast; oracle-capable (free, but verify it scores — see §0) | first smoke; verifying the loop/gate/finalize mechanics |
| `jq-surgeon` | no (empty splits, skill only) | **also exercises `skillopt-taskpack`** — task + verifier generation | testing the create→taskpack→loop path |
| `reversible-migrations` | no (empty splits, skill only) | same, on a harder skill (round-trip SQL property oracle) | testing taskpack on a non-trivial reward |

`hello-harbor` already has a complete `skillopt.config.json` (docker · claude-code · opus · mixed gate · 6 tasks split 3/2/1). It is a **toy with almost no headroom** — a competent agent saturates the selection split immediately. That is expected: a correct run should hit the ceiling and **stop cleanly** (see signatures below), not grind or balloon the skill. If you want to watch the loop actually *move* a skill across steps, that requires a target with real headroom — note that limitation in your report rather than expecting big gains on the toy.

---

## 3. Set up an isolated run directory

```bash
RUN=~/skillopt-runs/run-$(date +%Y%m%d-%H%M%S); mkdir -p "$RUN"; cd "$RUN"
```

`init_optimization` **stages** the seed skill and task pack into the run dir (copies them to `./skills/…` and `./tasks/`) and rewrites the config to the local copies, so the loop edits copies and **never mutates the example source**. Confirm this held after the run (signature checklist). Launch pi from `$RUN` so `ctx.cwd` — and therefore all run state — is here.

Pick one of two ways to seed `$RUN` (they test slightly different things):

- **A — copy the whole example in, run in place (simplest).** No path editing, no external staging:

  ```bash
  cp -r "$PLUGIN"/examples/hello-harbor/. "$RUN"/
  ```

  The config's relative paths (`./skills/...`, `./tasks`) now resolve inside `$RUN`; staging sees them as already-local and leaves them as-is.

- **B — keep the inputs external, exercise staging (tests the no-mutate guarantee).** Copy only the config, then point its paths at the example *source* so staging treats them as external and copies them in:

  ```bash
  cp "$PLUGIN"/examples/hello-harbor/skillopt.config.json "$RUN"/
  # edit skillUnderTest -> "$PLUGIN/examples/hello-harbor/skills/format-answer/SKILL.md"
  #       taskPack      -> "$PLUGIN/examples/hello-harbor/tasks"
  ```

  This is the variant that proves the source stays untouched — but note the paths **must** point outside `$RUN`, or staging's "already inside the run dir" check skips the copy and `init_optimization` then can't find the skill.

Or skip the config entirely and let `/skill:skillopt-create` build it interactively (which also tests that skill — see §4).

---

## 4. Drive the session

**Two different models are in play — don't conflate them.** `--model` is the model that *drives pi itself* (reads the skill, calls the tools, reflects); it's independent of `rollout.model` in `skillopt.config.json`, which is the model the agent runs *inside* the sandbox. Pick a `--model` that this `pi` build recognizes and that you have a key for. If pi prints `Model "<id>" not found … Using custom model id` or the provider rejects the request with `thinking.type.enabled is not supported for this model`, add **`--thinking off`** (an unknown/custom id defaults thinking on, which some models reject). The commands below include `--thinking off` defensively; swap the model id for one you have access to.

Two driving modes. Pick based on what you're testing.

### Mode A — interactive (tmux): the faithful test

Use this to test the **create-skill UX** (the one-question-at-a-time elicitation) and to watch the **timer-driven auto-loop** fire on its own — both are things only a live, persistent runtime exercises. Drive pi inside tmux so you can send keystrokes and read the pane.

```bash
S=skillopt-$$-$(date +%s)   # unique session name — a fixed name collides when test agents run in parallel
tmux new-session -d -s "$S" -x 220 -y 50
tmux send-keys -t "$S" "cd $RUN && export ANTHROPIC_API_KEY=… && pi -e $PLUGIN --skill $PLUGIN/skills/skillopt-create --skill $PLUGIN/skills/skillopt-taskpack --skill $PLUGIN/skills/skillopt-finalize --model <a-model-you-have-a-key-for> --thinking off --session-dir $RUN/.pi-sessions" Enter
sleep 5; tmux capture-pane -t "$S" -p          # confirm pi started (no 'Unknown option' / model error)
tmux send-keys -t "$S" "/skill:skillopt-create" Enter
sleep 4; tmux capture-pane -t "$S" -p          # read the first question
# answer one question at a time, reading the pane between each send:
tmux send-keys -t "$S" "use the format-answer skill in this example" Enter
# … continue answering: target outcome, backend (docker), agent+model, creds, preloads (none), tuning (defaults)
```

Drive it like a human tester: send one answer, `capture-pane`, read, send the next. After `init_optimization` runs the baseline and the first iteration calls `run_rollout`, the auto-loop should self-advance every ~1.5s of idle — watch successive `run_rollout`/`log_step` calls appear without you prompting. When it plateaus it prints a STOP notice; then send `/skill:skillopt-finalize`.

`--session-dir $RUN/.pi-sessions` keeps the transcript next to the run artifacts (and makes it easy to find — see §6) instead of under `~/.pi`.

### Mode B — CLI one-shot, turn-by-turn: the structured/scriptable test

Use this when you want machine-readable output and deterministic stepping. `--mode json` streams NDJSON events (tool calls, results, errors) to stdout. **Continue the conversation across invocations with `--continue`** (continues the most recent session for the cwd). Note: this `pi` build has **no `--session-id`** flag — `--continue` / `--resume` / `--session <path>` are the continuation flags. Run every turn from `$RUN` so the session is keyed to the run dir.

```bash
cd "$RUN"
COMMON="--mode json -e $PLUGIN --skill $PLUGIN/skills/skillopt-create --skill $PLUGIN/skills/skillopt-finalize --model <a-model-you-have-a-key-for> --thinking off --session-dir $RUN/.pi-sessions"
pi $COMMON -p "/skill:skillopt-create — optimize ./skills/format-answer/SKILL.md, docker backend, claude-code, defaults for everything; the pack is the existing ./tasks. Run the baseline." < /dev/null | tee turn1.ndjson
# read turn1.ndjson for the question it asked or the tool calls it made, then continue the SAME session:
pi $COMMON --continue -p "yes, proceed" < /dev/null | tee turn2.ndjson
```

**`< /dev/null` is mandatory here:** `pi -p` reads stdin, and when driven from a tool subshell that leaves stdin open it **hangs at startup** (no output, eventually a `timeout`/exit 124). Redirecting `< /dev/null` closes stdin and it returns immediately.

**Important:** in `-p`/print mode pi disposes the runtime when each prompt resolves, so the extension's internal auto-loop **does not self-fire** between invocations. That's fine for a manual test — **you are the loop**: after each turn, read the NDJSON, then `--continue` with the next "run the next iteration: reflect, edit, run_rollout('selection'), log_step" prompt yourself. (If you want to see the auto-loop fire on its own, use Mode A.)

Because `skillopt-create` is interactive (one question at a time), the cleanest one-shot path is to **pre-write `skillopt.config.json`** (so create has nothing to ask) and drive the tools directly: prompt 1 → "run `init_optimization` then `run_rollout('selection')` and `log_step` as the baseline"; subsequent prompts → "run the next iteration"; final → `/skill:skillopt-finalize`.

---

## 5. What to watch while it runs

Whichever mode, you're watching the **tool-call sequence** and the **gate's verdict** each step:

- `init_optimization` → should report the splits and, if selection has < 3 tasks, a `⚠️` thin-selection warning.
- `run_rollout(split)` → `hard`/`soft` scores + failing trajectories. Watch for `N trial(s) errored … NOT a skill failure` — that means infra (bad model id / missing backend extra / creds), not a skill problem.
- `log_step(edit, sel_hard, …)` → the gate's verdict: `ACCEPTED ★ new best`, `accepted`, or `REJECTED (reverted)`, plus `best`, `budget`, `conf`. A tie must reject.
- The widget (Mode A) shows `N steps · K kept · ★ metric: best% (±Δ)`.

---

## 6. Artifacts the run produces, and how to analyze them

Everything lands in `$RUN`. The ledger is the source of truth; read it first.

| File | What it tells you |
|------|-------------------|
| `skillopt.jsonl` | **the gate ledger** — a `config` header then one `step` row per iteration (action, sel_hard/soft, current/best score, edit_budget, confidence, skill_version). Authoritative for "what the gate did." |
| `best_skill.md` | the current best skill — the deliverable. Diff against the seed to see what optimization changed. |
| `skillopt.snapshots/skill_vNNNN.md` | one snapshot per **accepted** step (rejects don't snapshot). |
| `skillopt.jobs/` | raw Harbor job output per rollout — `result.json`, trajectories. Open this to see *why* a task failed. |
| `skillopt.md` | the living session doc (objective, rollout env, what's been tried). |
| pi transcript | the full conversation tree (model reasoning + every tool call/result). |

Render the gate story from the ledger:

```bash
jq -rc 'select(.type=="config")' "$RUN/skillopt.jsonl"      # the run header (splits, metric)
jq -rc 'select(.type=="step") | "\(.step) \(.action)  sel_hard=\(.sel_hard) best=\(.best_score)  v=\(.skill_version // "-")  | \(.edit)"' "$RUN/skillopt.jsonl"
```

Check the skill didn't balloon:

```bash
wc -l "$RUN"/skills/*/SKILL.md "$RUN/best_skill.md"   # compare against the seed's line count
```

For the **pi transcript** (large — don't read it inline; it'll blow up context): find the newest `.jsonl`, then export it to HTML or hand it to a subagent to mine.

```bash
# If you launched with --session-dir $RUN/.pi-sessions (recommended), it's simply the newest .jsonl there:
TX="$(find "$RUN/.pi-sessions" -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)"
# Otherwise it's under the default dir, keyed to the cwd pi was launched from (must be $RUN):
#   leading "/" dropped, every "/" ":" "\" -> "-", wrapped in --…--
[ -z "$TX" ] && TX="$(ls -t ~/.pi/agent/sessions/--$(echo "$RUN" | sed 's#^/##; s#[/:\\]#-#g')--/*.jsonl 2>/dev/null | head -1)"
pi --export "$TX" /tmp/skillopt-run.html   # readable HTML
```

If you used Mode B, the `*.ndjson` you `tee`'d already has the structured events — grep those for `init_optimization` / `run_rollout` / `log_step` and their results instead of parsing the tree.

---

## 7. Pass / fail signatures

A correct run should show the ✅ behaviors. The ❌ fingerprints are real bugs this project has hit before — if you see one, that's the headline of your report. This list doubles as a regression checklist.

**Should happen (✅):**
- `init_optimization` warns when the selection split has < 3 tasks.
- The baseline is logged as the first `step`.
- A second selection score equal to or below the current best is **`REJECTED (reverted)`** — not "new best."
- The skill file stays **bounded** in length; accepted edits replace/merge rather than only append.
- On a saturated selection (score hits the ceiling), the loop **stops** with a `DONE`/`PLATEAU` notice — it does not keep editing.
- `run_rollout('test')` during the loop is **refused** unless finalize passes `final: true`.
- After `skillopt-finalize` scores `test`, the loop does **not** re-arm (no extra rollout/edit fires afterward).
- An infra-errored trial is reported as `errored … NOT a skill failure` and **excluded** from the score (not scored as a real 0%).
- The example's **source** skill + task pack are untouched; all edits happened on staged copies in `$RUN`.
- The **exact** configured model id was used (no silent alias swap causing every rollout to error).

**Bug fingerprints (❌ — report immediately):**
- The skill grows every step (ballooning markdown).
- Every step logs `ACCEPTED ★ new best` while the score sits flat (gate comparing against a zero/transient baseline).
- A `PLATEAU: no new best in 0 steps` message (plateau reason mislabeled).
- Rollouts keep running after the selection split already hit 100%.
- A rollout fires *during or after* finalize and re-triggers editing.
- Each run renames task `task.toml` names (namespace churn) instead of `taskNamespace` handling it once.
- All rollouts error out (likely a bad/approximate model id, missing `harbor[<backend>]` extra, or an unset key) — but reported as skill failures rather than infra.

---

## 8. Iterate and clean up

- **Fresh dir per run** is the cleanest reset — staging re-copies inputs, so a new `$RUN` is a clean slate.
- To reset *within* a dir, run `/skillopt clear` (deletes `skillopt.jsonl` + `best_skill.md` and resets state). Note: re-running `init_optimization` does **not** reset — it resumes — by design.
- `/skillopt status` prints the current step/best; `/skillopt off` disables the mode (keeps files).

---

## 9. Report template

Capture this when you're done (or when blocked):

```
## skillopt manual test — <target>, <date>
- Prereqs: pi <ok/missing>, ANTHROPIC_API_KEY driver <ok/missing>, rollout-agent key <ok/missing>,
  harbor <ok/missing>, backend <docker/e2b + ok/missing>
- Mode: <A interactive / B one-shot>, agent/model: <…>
- How far it got: <created config / baselined / N loop steps / finalized> 
- Loop behavior: <accepted K / rejected M, best score, did it stop cleanly?>
- Signatures: <which ✅ confirmed, which ❌ seen — quote the exact line>
- Skill length: seed <X> lines → best <Y> lines
- UX friction: <any confusing prompt, wrong assumption, missing guidance in a skill>
- Blockers: <exact prerequisite or error that stopped the run, with the command output>
- Suggested fixes: <to the skills or extension, if any>
```

The most valuable parts are **UX friction** (a skill question that confused you, an assumption it made without confirming) and **signatures** (a ❌ fingerprint, quoted) — those are what turn a test run into a fix.
