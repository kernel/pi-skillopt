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
 *   - run_rollout       : run a Harbor rollout for a split, return score + failures
 *   - log_step          : apply the strict-improvement gate, snapshot/revert
 *
 * Wiring (reconciled against @mariozechner/pi-coding-agent):
 *   - session_start        -> rebuild runtime state from skillopt.jsonl
 *   - before_agent_start   -> inject a static skillopt-mode pointer into the prompt
 *   - agent_end            -> schedule the next loop iteration once settled
 *   - session_before_compact / session_compact -> compaction summary + re-arm
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SkillOptConfig, StepEntry, GateMetric } from "./types.ts";
import { evaluateGate, editBudgetAt, type GateState } from "./gate.ts";
import { makeSplits, assertDisjoint } from "./splits.ts";
import { runRollout } from "./harbor.ts";
import { appendEntry, reconstruct, confidence } from "./jsonl.ts";
import { buildSkilloptCompactionSummary, skilloptSummaryPathsFor } from "./compaction.ts";

// --- session file paths ----------------------------------------------------

const configPath = (d: string) => path.join(d, "skillopt.config.json");
const jsonlPath = (d: string) => path.join(d, "skillopt.jsonl");
const bestSkillPath = (d: string) => path.join(d, "best_skill.md");
const snapshotDir = (d: string) => path.join(d, "skillopt.snapshots");

// How long the agent must be settled (idle, no queued input) before the loop
// auto-sends the next iteration, and a hard cap so a runaway loop self-stops.
const SETTLED_WINDOW_MS = 1500;
const MAX_AUTORESUME_TURNS = 100;

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
  pendingResumeMessage: string | null;
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
  autoResumeTurns: number;
  /** Rollouts run this session — gates the auto-loop so a chat-only turn can't spin. */
  rolloutsThisSession: number;
}

function freshRuntime(): Runtime {
  return {
    active: false,
    step: 0,
    gate: { currentSkill: "", currentScore: 0, bestSkill: "", bestScore: 0, bestStep: 0 },
    steps: [],
    pendingResumeMessage: null,
    pendingResumeTimer: null,
    autoResumeTurns: 0,
    rolloutsThisSession: 0,
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
  const rt = (ctx: ExtensionContext): Runtime => {
    let r = runtimes.get(keyOf(ctx));
    if (!r) runtimes.set(keyOf(ctx), (r = freshRuntime()));
    return r;
  };

  // Registering through this gates the tool, so a new one can't slip in ungated.
  const gatedToolNames = new Set<string>();
  const registerGatedTool = (tool: Parameters<typeof pi.registerTool>[0]): void => {
    gatedToolNames.add(tool.name);
    pi.registerTool(tool);
  };

  const setActive = (ctx: ExtensionContext, on: boolean): void => {
    rt(ctx).active = on;
    const active = new Set(pi.getActiveTools()); // setActiveTools replaces the whole set
    for (const t of gatedToolNames) on ? active.add(t) : active.delete(t);
    pi.setActiveTools([...active]);
  };

  // -- auto-loop (settled-window resume) ------------------------------------
  const composeResumeMessage = (): string =>
    "Run the next skillopt iteration now: reflect on the latest failing trajectories, apply <= edit_budget bounded edits to the skill (generalizable, never task-specific answers), run_rollout('selection'), then log_step. Never roll out 'test'.";

  const composeCompactionResume = (): string =>
    "Continue the skillopt loop. The compaction summary already holds the objective, rules, and recent steps — do not re-read skillopt.md / skillopt.jsonl. Pick the next edit from the remaining failure classes, run_rollout('selection'), then log_step.";

  const isSettled = (ctx: ExtensionContext): boolean => ctx.isIdle() && !ctx.hasPendingMessages();

  const pausePendingResume = (r: Runtime): void => {
    if (!r.pendingResumeTimer) return;
    clearTimeout(r.pendingResumeTimer);
    r.pendingResumeTimer = null;
  };

  const cancelPendingResume = (r: Runtime): void => {
    pausePendingResume(r);
    r.pendingResumeMessage = null;
  };

  const sendPendingResumeIfReady = (ctx: ExtensionContext, r: Runtime): void => {
    const message = r.pendingResumeMessage;
    if (!message) return;
    if (!r.active) return cancelPendingResume(r);
    if (!isSettled(ctx)) return; // re-armed by the next agent_end
    if (r.autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      cancelPendingResume(r);
      ctx.ui.notify(`skillopt auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`, "info");
      return;
    }
    cancelPendingResume(r);
    r.autoResumeTurns++;
    pi.sendUserMessage(message);
  };

  const schedulePendingResume = (ctx: ExtensionContext, r: Runtime, message: string): void => {
    pausePendingResume(r);
    r.pendingResumeMessage = message;
    r.pendingResumeTimer = setTimeout(() => sendPendingResumeIfReady(ctx, r), SETTLED_WINDOW_MS);
  };

  const ensurePendingResume = (
    ctx: ExtensionContext,
    gate: (r: Runtime) => boolean,
    compose: () => string = composeResumeMessage,
  ): void => {
    const r = rt(ctx);
    if (r.pendingResumeMessage !== null) {
      schedulePendingResume(ctx, r, r.pendingResumeMessage);
      return;
    }
    if (!gate(r)) return;
    if (r.autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      ctx.ui.notify(`skillopt auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`, "info");
      return;
    }
    schedulePendingResume(ctx, r, compose());
  };

  // Why the rollout gate: a chat-only turn would otherwise loop forever, because
  // every agent_end would re-prompt, which would chat again.
  const shouldAutoResumeAfterTurn = (r: Runtime): boolean => r.active && r.rolloutsThisSession > 0;

  // -- rebuild state on session load ----------------------------------------
  const reconstructState = (ctx: ExtensionContext): void => {
    const dir = workDir(ctx);
    const st = reconstruct(jsonlPath(dir));
    if (!st) return;
    const r = rt(ctx);
    const skillAbs = resolve(dir, st.skillUnderTest);
    r.step = st.bestStep;
    r.steps = st.steps;
    r.gate = {
      currentSkill: skillAbs,
      currentScore: st.currentScore,
      bestSkill: skillAbs,
      bestScore: st.bestScore,
      bestStep: st.bestStep,
    };
    setActive(ctx, true);
    updateWidget(ctx);
  };

  // -- init_optimization ----------------------------------------------------
  registerGatedTool({
    name: "init_optimization",
    label: "Init Optimization",
    description:
      "Begin (or re-baseline) a skill-optimization session. Requires skillopt.config.json (written by skillopt-create) in the working dir. Derives splits if absent, writes the jsonl header, and snapshots the starting skill.",
    promptSnippet: "Begin a skill-optimization session (reads skillopt.config.json, derives splits, snapshots the seed skill).",
    parameters: InitParams,
    async execute(_toolCallId, params: Static<typeof InitParams>, _signal, _onUpdate, ctx) {
      const dir = workDir(ctx);
      const cfg = readConfig(dir);
      if (!cfg) return result(`No skillopt.config.json found in ${dir}. Run /skill:skillopt-create first.`);

      if (!cfg.splits || cfg.splits.train.length + cfg.splits.selection.length === 0) {
        const ids = discoverTaskIds(resolve(dir, cfg.taskPack));
        cfg.splits = makeSplits(ids, "60:20:20");
        fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
      }
      assertDisjoint(cfg.splits);

      fs.mkdirSync(snapshotDir(dir), { recursive: true });
      const skillAbs = resolve(dir, cfg.skillUnderTest);
      fs.writeFileSync(bestSkillPath(dir), fs.readFileSync(skillAbs, "utf-8"));

      const r = rt(ctx);
      r.step = 0;
      r.gate = { currentSkill: skillAbs, currentScore: 0, bestSkill: skillAbs, bestScore: 0, bestStep: 0 };
      r.steps = [];

      appendEntry(jsonlPath(dir), {
        type: "config",
        timestamp: Date.now(),
        name: params.name,
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
      return result(
        `Initialized "${params.name}". Splits — train ${cfg.splits.train.length} / selection ${cfg.splits.selection.length} / test ${cfg.splits.test.length}. ` +
          `Now run a baseline: run_rollout(selection), log it as step 0, then start the loop. Do NOT run_rollout('test').`,
      );
    },
  });

  // -- run_rollout ----------------------------------------------------------
  registerGatedTool({
    name: "run_rollout",
    label: "Run Rollout",
    description:
      "Run the configured agent over a split inside the Harbor rollout env with the CURRENT skill injected. Returns aggregate hard/soft scores and a sample of failing trajectories to reflect on. Never roll out 'test' during the loop.",
    promptSnippet: "Roll the current skill out over a split (train/selection) and get hard/soft scores + failing trajectories.",
    parameters: RunRolloutParams,
    async execute(_toolCallId, params: Static<typeof RunRolloutParams>, _signal, _onUpdate, ctx) {
      const dir = workDir(ctx);
      const cfg = readConfig(dir);
      if (!cfg) return result("No active session. Run init_optimization first.");
      const ids = cfg.splits[params.split];
      if (!ids?.length) return result(`Split "${params.split}" is empty.`);

      const rollout = await runRollout({
        taskPack: resolve(dir, cfg.taskPack),
        skillPath: rt(ctx).gate.currentSkill || resolve(dir, cfg.skillUnderTest),
        taskIds: ids,
        split: params.split,
        env: cfg.rollout,
        // Keep Harbor's job output (incl. failing trajectories) in the session
        // dir so the agent can read it and `/skillopt clear` can remove it.
        jobsDir: path.join(dir, "skillopt.jobs"),
        attempts: cfg.selectionSamples && params.split === "selection" ? cfg.selectionSamples : 1,
        sampleFailures: params.sample_failures,
      });

      rt(ctx).rolloutsThisSession++;

      const lines = [
        `Rollout on ${params.split}: hard ${pct(rollout.hard)} · soft ${rollout.soft.toFixed(3)} (${rollout.perTask.length} tasks)`,
        rollout.failing.length ? `\nFailing tasks to reflect on:` : `\nNo failures in this split.`,
        ...rollout.failing.map((f) => `  - ${f.taskId}: ${JSON.stringify(f.rewards)}${f.trajectory ? `  trajectory: ${f.trajectory}` : ""}`),
        params.split === "train"
          ? `\nPropose <= edit_budget bounded edits to the skill that fix the COMMON failure pattern, then run_rollout('selection') and log_step.`
          : ``,
      ];
      return result(lines.join("\n"), { rollout });
    },
  });

  // -- log_step (the gate) --------------------------------------------------
  registerGatedTool({
    name: "log_step",
    label: "Log Step",
    description:
      "Submit the candidate skill (your applied edits) to the validation gate. The gate compares the SELECTION score strictly against the current best: accept -> snapshot + update best_skill.md; reject -> revert the skill file. A tie is rejected.",
    promptSnippet: "Submit your edited skill to the strict-improvement gate (accept+snapshot or reject+revert).",
    parameters: LogStepParams,
    async execute(_toolCallId, params: Static<typeof LogStepParams>, _signal, _onUpdate, ctx) {
      const dir = workDir(ctx);
      const cfg = readConfig(dir);
      if (!cfg) return result("No active session.");
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
        candHard: params.sel_hard,
        candSoft: params.sel_soft ?? 0,
        metric,
        mixedWeight: cfg.mixedWeight,
        current: r.gate,
        step: r.step,
      });

      let snapshot: string | undefined;
      if (outcome.action === "reject") {
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
        timestamp: Date.now(),
        edit: params.edit,
        sel_hard: params.sel_hard,
        sel_soft: params.sel_soft ?? 0,
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
      return result(
        `Step ${r.step}: ${verb}. selection ${metric}=${pct(metric === "soft" ? params.sel_soft ?? 0 : params.sel_hard)} · best ${pct(outcome.bestScore)} · budget ${budget}` +
          (entry.confidence !== null ? ` · conf ${entry.confidence.toFixed(1)}×` : ``) +
          `. Continue the loop.`,
        { action: outcome.action, best_score: outcome.bestScore },
      );
    },
  });

  // -- events ---------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    reconstructState(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelPendingResume(rt(ctx));
    runtimes.delete(keyOf(ctx));
  });

  pi.on("agent_start", async (_event, ctx) => {
    const r = rt(ctx);
    r.rolloutsThisSession = 0;
    pausePendingResume(r);
  });

  // After each turn, if a rollout ran and we're in skillopt mode, schedule the
  // next iteration once the agent settles.
  pi.on("agent_end", async (_event, ctx) => {
    ensurePendingResume(ctx, shouldAutoResumeAfterTurn);
  });

  // A short, static, cache-safe pointer into the system prompt while active.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!rt(ctx).active) return;
    const note =
      "\n\n## SkillOpt Mode (ACTIVE)" +
      "\nYou are optimizing a SKILL.md via gated Harbor rollouts. Each iteration: reflect on failing train/selection trajectories, apply <= edit_budget bounded edits to the skill, run_rollout('selection'), then log_step — the gate keeps or reverts." +
      "\nNever roll out 'test' (it is the held-out final number). Never hardcode task-specific answers into the skill. Keep going until the selection score plateaus or you are interrupted.";
    return { systemPrompt: event.systemPrompt + note };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    pausePendingResume(rt(ctx));
    if (!rt(ctx).active) return;
    return {
      compaction: {
        summary: buildSkilloptCompactionSummary(skilloptSummaryPathsFor(workDir(ctx))),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.on("session_compact", async (_event, ctx) => {
    ensurePendingResume(ctx, (r) => r.active, composeCompactionResume);
  });

  // -- /skillopt command ----------------------------------------------------
  pi.registerCommand("skillopt", {
    description: "skillopt session controls: status | off | clear",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const dir = workDir(ctx);
      const sub = (args || "status").trim().toLowerCase();

      if (sub === "off") {
        setActive(ctx, false);
        cancelPendingResume(rt(ctx));
        ctx.ui.notify("skillopt mode off. Session files kept.", "info");
        return;
      }
      if (sub === "clear") {
        for (const p of [jsonlPath(dir), bestSkillPath(dir)]) if (fs.existsSync(p)) fs.unlinkSync(p);
        runtimes.set(keyOf(ctx), freshRuntime());
        setActive(ctx, false);
        updateWidget(ctx);
        ctx.ui.notify("Cleared skillopt.jsonl + best_skill.md and reset state.", "info");
        return;
      }
      const st = reconstruct(jsonlPath(dir));
      ctx.ui.notify(
        st
          ? `skillopt "${st.name}" — ${st.steps.length} steps · best ${pct(st.bestScore)} · metric ${st.gateMetric}`
          : "No skillopt session yet. /skill:skillopt-create to begin.",
        "info",
      );
    },
  });

  // -- widget ---------------------------------------------------------------
  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const dir = workDir(ctx);
    const st = reconstruct(jsonlPath(dir));
    ctx.ui.setWidget("skillopt", (_tui, theme) => ({
      render(): string[] {
        if (!st) return [theme.fg("muted", "🧪 skillopt — no session")];
        const kept = st.steps.filter((s) => s.action !== "reject").length;
        const base = st.steps[0]?.current_score ?? 0;
        const delta = base ? ((st.bestScore - base) / base) * 100 : 0;
        return [
          [
            theme.fg("accent", "🧪"),
            theme.fg("muted", ` ${st.steps.length} steps`),
            theme.fg("success", ` ${kept} kept`),
            theme.fg("muted", " │ "),
            theme.fg("warning", `★ ${st.gateMetric}: ${pct(st.bestScore)}`),
            base && st.bestScore !== base ? theme.fg(delta >= 0 ? "success" : "error", ` (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)`) : "",
          ].join(""),
        ];
      },
      invalidate(): void {},
    }));
  }

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

/** A pi tool result carrying a text block (what the agent sees) plus structured details. */
function result(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}
