/**
 * pi-skillopt — Pi Extension
 *
 * Generic infrastructure for optimizing a single SKILL.md against a Harbor
 * eval/rollout substrate, using SkillOpt's validation-gated discipline. The
 * domain knowledge (what skill, what tasks, what rollout env) lives in the
 * skills (skillopt-create / skillopt-taskpack / skillopt-finalize) and in the
 * per-session config file — never here.
 *
 * The loop, driven by the agent:
 *   reflect on failing train rollouts -> edit the skill (<= edit_budget edits)
 *   -> log_step -> gate re-scores the candidate on the SELECTION split
 *   -> accept (snapshot + best_skill.md) or reject (revert) -> repeat.
 *
 * Tools (gated on while a session is active):
 *   - init_optimization : write config + jsonl header, derive splits, baseline
 *   - run_rollout       : run `harbor run` for a split, return score + failures
 *   - log_step          : apply the strict-improvement gate, snapshot/revert
 *
 * STATUS: scaffold. The loop/gate/harbor/splits/jsonl logic is real and unit-
 * testable, but the pi event wiring (tool-handler signature, before_agent_start,
 * compaction, idle auto-resume) is shaped from pi-autoresearch and must be
 * reconciled against the installed @mariozechner/pi-coding-agent typings during
 * integration. Reconciliation points are marked `RECONCILE:`.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SkillOptConfig, StepEntry, GateMetric } from "./types.ts";
import { evaluateGate, editBudgetAt, type GateState } from "./gate.ts";
import { makeSplits, assertDisjoint } from "./splits.ts";
import { runRollout } from "./harbor.ts";
import { appendEntry, reconstruct, confidence } from "./jsonl.ts";

// --- session file paths ----------------------------------------------------

const configPath = (d: string) => path.join(d, "skillopt.config.json");
const jsonlPath = (d: string) => path.join(d, "skillopt.jsonl");
const mdPath = (d: string) => path.join(d, "skillopt.md");
const bestSkillPath = (d: string) => path.join(d, "best_skill.md");
const snapshotDir = (d: string) => path.join(d, "skillopt.snapshots");

function readConfig(dir: string): SkillOptConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(dir), "utf-8")) as SkillOptConfig;
  } catch {
    return null;
  }
}

// --- per-session runtime ---------------------------------------------------

interface Runtime {
  active: boolean;
  step: number;
  gate: GateState;
  steps: StepEntry[];
}

function freshRuntime(): Runtime {
  return {
    active: false,
    step: 0,
    gate: { currentSkill: "", currentScore: 0, bestSkill: "", bestScore: 0, bestStep: 0 },
    steps: [],
  };
}

// --- tool schemas ----------------------------------------------------------

const InitParams = Type.Object({
  name: Type.String({ description: "Human-readable session name." }),
});

const RunRolloutParams = Type.Object({
  split: Type.Union(
    [Type.Literal("train"), Type.Literal("selection"), Type.Literal("test")],
    { description: "Which split to roll out. Reflect on 'train'; the gate uses 'selection'; 'test' is for finalize only." },
  ),
  sample_failures: Type.Optional(Type.Number({ description: "Max failing trajectories to surface (default 4)." })),
});

const LogStepParams = Type.Object({
  edit: Type.String({ description: "Short description of the bounded edit(s) you applied to the skill this step." }),
  sel_hard: Type.Number({ description: "Candidate hard score on the SELECTION split (from a run_rollout on 'selection')." }),
  sel_soft: Type.Optional(Type.Number({ description: "Candidate soft score on the SELECTION split. Required when gate_metric is soft/mixed." })),
});

// --- extension -------------------------------------------------------------

export default function skilloptExtension(pi: ExtensionAPI) {
  const runtimes = new Map<string, Runtime>();
  const keyOf = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const rt = (ctx: ExtensionContext) => {
    let r = runtimes.get(keyOf(ctx));
    if (!r) runtimes.set(keyOf(ctx), (r = freshRuntime()));
    return r;
  };

  const gatedTools = new Set<string>();
  const register = (tool: Parameters<typeof pi.registerTool>[0]) => {
    gatedTools.add(tool.name);
    pi.registerTool(tool);
  };

  const setActive = (ctx: ExtensionContext, on: boolean) => {
    rt(ctx).active = on;
    const active = new Set(pi.getActiveTools());
    for (const t of gatedTools) (on ? active.add(t) : active.delete(t));
    pi.setActiveTools([...active]);
  };

  // -- init_optimization ----------------------------------------------------
  register({
    name: "init_optimization",
    description:
      "Begin (or re-baseline) a skill-optimization session. Requires skillopt.config.json (written by skillopt-create) in the working dir. Derives splits if absent, writes the jsonl header, and snapshots the starting skill.",
    parameters: InitParams,
    // RECONCILE: confirm the (args, ctx) handler shape against pi typings.
    execute: async (args: { name: string }, ctx: ExtensionContext) => {
      const dir = workDir(ctx);
      const cfg = readConfig(dir);
      if (!cfg) return text(`No skillopt.config.json found in ${dir}. Run /skill:skillopt-create first.`);

      // Derive splits from the task pack if the config didn't pin them.
      if (!cfg.splits || cfg.splits.train.length + cfg.splits.selection.length === 0) {
        const ids = discoverTaskIds(resolve(dir, cfg.taskPack));
        cfg.splits = makeSplits(ids, "60:20:20");
        fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
      }
      assertDisjoint(cfg.splits);

      fs.mkdirSync(snapshotDir(dir), { recursive: true });
      const skillAbs = resolve(dir, cfg.skillUnderTest);
      const seed = fs.readFileSync(skillAbs, "utf-8");
      fs.writeFileSync(bestSkillPath(dir), seed);

      const r = rt(ctx);
      r.step = 0;
      r.gate = { currentSkill: skillAbs, currentScore: 0, bestSkill: skillAbs, bestScore: 0, bestStep: 0 };
      r.steps = [];

      appendEntry(jsonlPath(dir), {
        type: "config",
        timestamp: nowFromCtx(ctx),
        name: args.name,
        skill_under_test: cfg.skillUnderTest,
        task_pack: cfg.taskPack,
        gate_metric: cfg.gateMetric ?? "hard",
        splits: {
          train: cfg.splits.train.length,
          selection: cfg.splits.selection.length,
          test: cfg.splits.test.length,
        },
      });

      setActive(ctx, true);
      updateWidget(ctx);
      return text(
        `Initialized "${args.name}". Splits — train ${cfg.splits.train.length} / selection ${cfg.splits.selection.length} / test ${cfg.splits.test.length}. ` +
          `Now run a baseline: run_rollout(selection), log it as step 0, then start the loop. Do NOT run_rollout('test').`,
      );
    },
  });

  // -- run_rollout ----------------------------------------------------------
  register({
    name: "run_rollout",
    description:
      "Run the configured agent over a split inside the Harbor rollout env with the CURRENT skill mounted. Returns aggregate hard/soft scores and a sample of failing trajectories to reflect on. Never roll out 'test' during the loop.",
    parameters: RunRolloutParams,
    execute: async (args: { split: "train" | "selection" | "test"; sample_failures?: number }, ctx: ExtensionContext) => {
      const dir = workDir(ctx);
      const cfg = readConfig(dir);
      if (!cfg) return text("No active session. Run init_optimization first.");
      const ids = cfg.splits[args.split];
      if (!ids?.length) return text(`Split "${args.split}" is empty.`);

      const result = await runRollout({
        taskPack: resolve(dir, cfg.taskPack),
        skillPath: rt(ctx).gate.currentSkill || resolve(dir, cfg.skillUnderTest),
        taskIds: ids,
        split: args.split,
        env: cfg.rollout,
        // Keep Harbor's job output (incl. failing trajectories) in the session
        // dir so the agent can read it and `/skillopt clear` can remove it.
        jobsDir: path.join(dir, "skillopt.jobs"),
        attempts: cfg.selectionSamples && args.split === "selection" ? cfg.selectionSamples : 1,
        sampleFailures: args.sample_failures,
      });

      const lines = [
        `Rollout on ${args.split}: hard ${pct(result.hard)} · soft ${result.soft.toFixed(3)} (${result.perTask.length} tasks)`,
        result.failing.length ? `\nFailing tasks to reflect on:` : `\nNo failures in this split.`,
        ...result.failing.map((f) => `  - ${f.taskId}: ${JSON.stringify(f.rewards)}${f.trajectory ? `  trajectory: ${f.trajectory}` : ""}`),
        args.split === "train"
          ? `\nPropose <= edit_budget bounded edits to the skill that fix the COMMON failure pattern, then run_rollout('selection') and log_step.`
          : ``,
      ];
      return { output: lines.join("\n"), details: { result } };
    },
  });

  // -- log_step (the gate) --------------------------------------------------
  register({
    name: "log_step",
    description:
      "Submit the candidate skill (your applied edits) to the validation gate. The gate compares the SELECTION score strictly against the current best: accept -> snapshot + update best_skill.md; reject -> revert the skill file. A tie is rejected.",
    parameters: LogStepParams,
    execute: async (args: { edit: string; sel_hard: number; sel_soft?: number }, ctx: ExtensionContext) => {
      const dir = workDir(ctx);
      const cfg = readConfig(dir);
      if (!cfg) return text("No active session.");
      const r = rt(ctx);
      const metric: GateMetric = cfg.gateMetric ?? "hard";
      const skillAbs = resolve(dir, cfg.skillUnderTest);

      r.step += 1;
      const budget = editBudgetAt(
        r.step,
        cfg.maxSteps ?? 40,
        cfg.editBudget,
        cfg.minEditBudget ?? Math.max(1, Math.floor(cfg.editBudget / 2)),
        cfg.lrSchedule ?? "cosine",
      );

      const outcome = evaluateGate({
        candidateSkill: skillAbs,
        candHard: args.sel_hard,
        candSoft: args.sel_soft ?? 0,
        metric,
        mixedWeight: cfg.mixedWeight,
        current: r.gate,
        step: r.step,
      });

      let snapshot: string | undefined;
      if (outcome.action === "reject") {
        // Revert the working skill back to the last accepted version.
        if (r.gate.currentScore > 0) fs.copyFileSync(snapshotFor(dir, r.gate.bestStep), skillAbs);
      } else {
        snapshot = `skill_v${String(r.step).padStart(4, "0")}.md`;
        fs.copyFileSync(skillAbs, path.join(snapshotDir(dir), snapshot));
        if (outcome.action === "accept_new_best") fs.copyFileSync(skillAbs, bestSkillPath(dir));
      }
      r.gate = outcome;

      const entry: StepEntry = {
        type: "step",
        step: r.step,
        segment: (reconstruct(jsonlPath(dir))?.segment ?? 1) - 1,
        timestamp: nowFromCtx(ctx),
        edit: args.edit,
        sel_hard: args.sel_hard,
        sel_soft: args.sel_soft ?? 0,
        gate_metric: metric,
        action: outcome.action,
        current_score: outcome.currentScore,
        best_score: outcome.bestScore,
        edit_budget: budget,
        confidence: null,
        skill_version: snapshot,
      };
      r.steps.push(entry);
      const base = r.steps[0]?.current_score ?? 0;
      entry.confidence = confidence(r.steps, metric === "soft" ? "sel_soft" : "sel_hard", base, outcome.bestScore);
      appendEntry(jsonlPath(dir), entry);
      updateWidget(ctx);

      const verb = outcome.action === "reject" ? "REJECTED (reverted)" : outcome.action === "accept_new_best" ? "ACCEPTED ★ new best" : "accepted";
      return text(
        `Step ${r.step}: ${verb}. selection ${metric}=${pct(metric === "soft" ? args.sel_soft ?? 0 : args.sel_hard)} · best ${pct(outcome.bestScore)} · budget ${budget}` +
          (entry.confidence !== null ? ` · conf ${entry.confidence.toFixed(1)}×` : ``) +
          `. Continue the loop.`,
      );
    },
  });

  // -- /skillopt command ----------------------------------------------------
  // RECONCILE: command registration API (pi.registerCommand) name/shape.
  pi.registerCommand?.({
    name: "skillopt",
    description: "skillopt session controls: status | off | clear",
    execute: async (arg: string, ctx: ExtensionContext) => {
      const dir = workDir(ctx);
      const sub = (arg || "status").trim();
      if (sub === "off") {
        setActive(ctx, false);
        return text("skillopt mode off. Session files kept.");
      }
      if (sub === "clear") {
        for (const p of [jsonlPath(dir), bestSkillPath(dir)]) if (fs.existsSync(p)) fs.unlinkSync(p);
        runtimes.set(keyOf(ctx), freshRuntime());
        setActive(ctx, false);
        return text("Cleared skillopt.jsonl + best_skill.md and reset state.");
      }
      const st = reconstruct(jsonlPath(dir));
      if (!st) return text("No skillopt session yet. /skill:skillopt-create to begin.");
      return text(`skillopt "${st.name}" — ${st.steps.length} steps · best ${pct(st.bestScore)} · metric ${st.gateMetric}`);
    },
  });

  // -- auto-loop ------------------------------------------------------------
  // RECONCILE: wire to pi's idle / agent-end signal like pi-autoresearch does,
  // capped at a max number of auto-resumes; re-prompt only after the agent has
  // run at least one rollout this session (otherwise a chat-only turn loops).
  const resumeMessage =
    "Run the next iteration: pick the strongest hypothesis from the latest failing trajectories, " +
    "apply <= edit_budget bounded edits to the skill, run_rollout('selection'), then log_step. " +
    "Do not edit the skill to hardcode answers to specific tasks, and never roll out 'test'.";
  void resumeMessage; // consumed by the idle hook once wired.

  // -- widget ---------------------------------------------------------------
  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const dir = workDir(ctx);
    const st = reconstruct(jsonlPath(dir));
    ctx.ui.setWidget("skillopt", (_tui, theme) => ({
      render(): string[] {
        if (!st) return [theme.fg("dim", "🧪 skillopt — no session")];
        const kept = st.steps.filter((s) => s.action !== "reject").length;
        const base = st.steps[0]?.current_score ?? 0;
        const delta = base ? ((st.bestScore - base) / base) * 100 : 0;
        return [
          [
            theme.fg("accent", "🧪"),
            theme.fg("muted", ` ${st.steps.length} steps`),
            theme.fg("success", ` ${kept} kept`),
            theme.fg("dim", " │ "),
            theme.fg("warning", `★ ${st.gateMetric}: ${pct(st.bestScore)}`),
            base && st.bestScore !== base ? theme.fg(delta >= 0 ? "success" : "error", ` (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)`) : "",
          ].join(""),
        ];
      },
      invalidate() {},
    }));
  }

  // Reconstruct state on load if a session is already on disk.
  // RECONCILE: pi's "session loaded" hook to call this.
  return { name: "pi-skillopt" };
}

// --- helpers ---------------------------------------------------------------

function workDir(ctx: ExtensionContext): string {
  const cfg = readConfig(ctx.cwd);
  const wd = cfg?.workingDir;
  if (!wd) return ctx.cwd;
  return path.isAbsolute(wd) ? wd : path.resolve(ctx.cwd, wd);
}

function resolve(dir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(dir, p);
}

function snapshotFor(dir: string, step: number): string {
  return path.join(snapshotDir(dir), `skill_v${String(step).padStart(4, "0")}.md`);
}

/** Task ids = subdirectory names of the task pack (one dir per task). */
function discoverTaskIds(taskPack: string): string[] {
  if (!fs.existsSync(taskPack)) throw new Error(`task pack not found: ${taskPack}`);
  return fs
    .readdirSync(taskPack, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function text(s: string) {
  return { output: s };
}

// new Date() is avoided so behavior is deterministic under pi's replay; pi
// surfaces the wall clock via ctx where available.
function nowFromCtx(ctx: ExtensionContext): number {
  const t = (ctx as unknown as { now?: () => number }).now?.();
  return typeof t === "number" ? t : 0;
}
