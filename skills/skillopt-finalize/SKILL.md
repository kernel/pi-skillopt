---
name: skillopt-finalize
description: Close out a skillopt run — measure the optimized skill on the held-out test split, produce best_skill.md, and emit a clean diff + report against the original skill. Use when a skillopt loop has plateaued or the user asks to "finalize", "wrap up the skillopt run", or "get the final number".
---

# skillopt — finalize

Turn a noisy optimization run into one honest number and one clean artifact.

The loop only ever touched the **train** and **selection** splits. `test` has been off limits — finalize is the *only* time it's scored, so the headline number isn't overfit to the gate.

## Steps

1. **Confirm the run is done.** The selection score should have plateaued (several consecutive rejects, or `maxSteps` reached). If it's still climbing, keep looping instead. **If `skillopt.jsonl` has no step rows** (e.g. the baseline saturated immediately and was never logged), there's nothing optimized to ship — log the baseline first with `log_step(edit: "baseline", …)` so the run has a recorded score, or proceed but state plainly in the report that no optimization steps ran and the test number is just the seed's.

2. **Score the seed on test (baseline).** Check out the original skill (the seed) and `run_rollout(split: 'test', final: true)`. Record `hard`/`soft`. This is the "before". (`final: true` is required — the `test` split is otherwise blocked during the loop.)

3. **Score `best_skill.md` on test.** Put `best_skill.md` in place and `run_rollout(split: 'test', final: true)`. Record `hard`/`soft`. This is the "after". Run each a few times if the env is noisy and report the mean ± spread.

4. **Write the report** (`skillopt.report.md`):
   - **Headline:** test `hard` seed → best (absolute + %), and the same for `soft`.
   - **Selection trajectory:** baseline → best selection score and the number of accepted vs rejected edits (from `skillopt.jsonl`).
   - **What changed:** summarize the accepted edits as a short changelog (from the snapshots / jsonl `edit` fields).
   - **Cost:** token/$ and wall-clock spend of the run (rollouts × tasks × steps), so the reader can judge whether the lift was worth it.
   - **Honesty notes:** any caveats — small test split, noisy verifier, a single benchmark, edits that look fragile.

5. **Produce the diff.** Show `git diff <seed> best_skill.md` (or a plain diff of the two files). This is the reviewable change a human approves before the optimized skill ships back to wherever the skill lives.

6. **Decision gate for the human.** Present: the test lift, the diff, the cost, and the honesty notes. Recommend ship / iterate / discard:
   - **Ship** if the test lift is real (beyond noise) and the diff is sane.
   - **Iterate** if selection improved but test didn't — likely overfit to the selection split; enlarge selection or the task pack.
   - **Discard** if there's no test lift — the skill may already be good, or the task pack/verifiers don't capture what matters (revisit `skillopt-taskpack`).

7. **Close the run.** Run `/skillopt off` — finalize is terminal, so turn skillopt mode off to stop the loop from auto-resuming after the test scoring.

## Output
- `best_skill.md` — the deployable artifact.
- `skillopt.report.md` — the test-split report + changelog + cost + caveats.
- a diff of seed → best for human review.

Do **not** claim a win from the selection score alone. The selection split is what the gate optimized against; only the untouched **test** split is evidence the skill actually got better.
