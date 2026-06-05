// The Harbor seam.
//
// This is the ONLY module that knows how to talk to Harbor. Everything else in
// the plugin deals in skills, scores, and gate decisions. Swapping eval
// substrates later means rewriting only this file.
//
// A rollout = run the configured agent (claude-code / codex / pi / ...) inside
// the configured backend (docker / daytona / e2b / runloop / ...), with the
// CANDIDATE skill injected, over a set of task ids, then read each task's
// verifier rewards back as a score.
//
// Pinned against Harbor 0.13.x (`harbor.models.job.config:JobConfig`):
//   - a run is `harbor run --config <job.json>`; there are no -p/-a/-m flags.
//   - the agent + model + injected skills live in `agents[]`; a skill is a
//     DIRECTORY containing SKILL.md (Harbor mounts it under /harbor/skills/<name>).
//   - the sandbox backend is `environment.type`.
//   - tasks are listed explicitly in `tasks[]` (one dir per task), which is how
//     a split is expressed.
//   - results land in `<jobs_dir>/<job_name>/result.json` (a JobResult); each
//     `trial_results[i].verifier_result.rewards` is that task's reward map.
//
// Run-time vs build-time split: this file uses only the run-time half of the
// rollout env (backend, agent, model, companion skills, secrets). The build-time
// half (base image + apt/npm/pip preloads) is baked into each task's
// `environment/Dockerfile` by skillopt-taskpack — Harbor has no run-time preload
// hook, so preloads MUST live in the task images, not here.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RolloutEnv, RolloutResult, PerTaskResult } from "./types.ts";

export interface RolloutRequest {
  /** Dir containing one subdirectory per Harbor task. */
  taskPack: string;
  /** Path to the candidate SKILL.md (the live file the loop edits in place). */
  skillPath: string;
  /** Task subdir names making up this split. */
  taskIds: string[];
  split: "train" | "selection" | "test";
  env: RolloutEnv;
  /** Where Harbor writes job output. Default <tmp>/skillopt-jobs. Trajectories live here. */
  jobsDir?: string;
  /** Unique job name. Default generated; a reused name makes Harbor try to resume. */
  jobName?: string;
  /** Skill directory name Harbor injects under. Default derived from skillPath. */
  skillName?: string;
  /** Attempts per task (Harbor n_attempts). Default 1. */
  attempts?: number;
  /** Concurrent trials. Default 4. */
  concurrency?: number;
  /** Minimum reward for a hard pass. Default 1. */
  passThreshold?: number;
  /** Reward key that decides the hard pass. If unset, ALL rewards must clear the threshold. */
  primaryReward?: string;
  /** Up to this many failing trajectories are surfaced to the agent. Default 4. */
  sampleFailures?: number;
  /** Per-rollout timeout in seconds. Default 1800. */
  timeoutSeconds?: number;
  /** Rebuild task images even if cached. Default false (build once, reuse). */
  forceBuild?: boolean;
  harborBin?: string;
}

/** The subset of Harbor's JobConfig this seam emits. */
export interface HarborJobConfig {
  job_name: string;
  jobs_dir: string;
  n_attempts: number;
  n_concurrent_trials: number;
  environment: {
    type: string;
    force_build?: boolean;
    env?: Record<string, string>;
  };
  agents: Array<{
    name: string;
    model_name: string;
    skills: string[];
    env?: Record<string, string>;
  }>;
  tasks: Array<{ path: string }>;
}

/** Harbor has no "local" env type; treat it as docker. Everything else passes through. */
function backendToEnvType(backend: string): string {
  return backend === "local" ? "docker" : backend;
}

/** Secret/env-var names -> a `${NAME}` map Harbor resolves from the host env at run time. */
function secretEnv(names: string[] | undefined): Record<string, string> | undefined {
  if (!names?.length) return undefined;
  const out: Record<string, string> = {};
  for (const n of names) out[n] = "${" + n + "}";
  return out;
}

/** Build the Harbor JobConfig for a rollout. Pure + testable. */
export function buildJobConfig(req: RolloutRequest, skillDir: string): HarborJobConfig {
  const { env } = req;
  const companions = env.setup?.skills ?? [];
  const agentEnv = secretEnv(env.setup?.env);
  return {
    job_name: req.jobName ?? defaultJobName(req.split),
    jobs_dir: req.jobsDir ?? path.join(os.tmpdir(), "skillopt-jobs"),
    n_attempts: req.attempts ?? 1,
    n_concurrent_trials: req.concurrency ?? 4,
    environment: {
      type: backendToEnvType(env.backend),
      force_build: req.forceBuild ?? false,
    },
    agents: [
      {
        name: String(env.agent),
        model_name: env.model,
        skills: [skillDir, ...companions],
        ...(agentEnv ? { env: agentEnv } : {}),
      },
    ],
    tasks: req.taskIds.map((id) => ({ path: path.join(req.taskPack, id) })),
  };
}

export function serializeJobConfig(cfg: HarborJobConfig): string {
  return JSON.stringify(cfg, null, 2);
}

/**
 * Resolve the directory Harbor should inject as the skill. Harbor wants a dir
 * containing SKILL.md; the live skill file already sits in one, so we reuse it.
 * A non-SKILL.md file (e.g. best_skill.md in finalize) is staged into a temp dir.
 */
function resolveSkillDir(req: RolloutRequest, scratch: string): string {
  const base = path.basename(req.skillPath);
  if (base === "SKILL.md") return path.dirname(req.skillPath);
  const name = req.skillName ?? base.replace(/\.md$/i, "");
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(req.skillPath, path.join(dir, "SKILL.md"));
  return dir;
}

/**
 * Run a rollout and aggregate the per-trial verifier rewards into a single
 * RolloutResult. `hard` is the split pass-rate; `soft` is the mean reward.
 */
export async function runRollout(req: RolloutRequest): Promise<RolloutResult> {
  const bin = req.harborBin ?? "harbor";
  const jobsDir = req.jobsDir ?? path.join(os.tmpdir(), "skillopt-jobs");
  const jobName = req.jobName ?? defaultJobName(req.split);
  fs.mkdirSync(jobsDir, { recursive: true });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "skillopt-rollout-"));
  const skillDir = resolveSkillDir(req, scratch);
  const cfg = buildJobConfig({ ...req, jobsDir, jobName }, skillDir);
  const cfgPath = path.join(scratch, "job.json");
  fs.writeFileSync(cfgPath, serializeJobConfig(cfg));

  await spawnHarbor(bin, ["run", "--config", cfgPath], (req.timeoutSeconds ?? 1800) * 1000);

  const jobDir = path.join(jobsDir, jobName);
  const resultPath = path.join(jobDir, "result.json");
  if (!fs.existsSync(resultPath)) {
    throw new Error(`harbor wrote no result.json at ${resultPath} (the job failed before producing results)`);
  }
  const raw = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
  const perTask = parseJobResult(raw, {
    jobDir,
    passThreshold: req.passThreshold ?? 1,
    primaryReward: req.primaryReward,
  });

  const hard = mean(perTask.map((t) => t.hard));
  const soft = mean(perTask.map((t) => t.soft));
  const failing = perTask.filter((t) => t.hard === 0).slice(0, req.sampleFailures ?? 4);
  return { split: req.split, hard, soft, perTask, failing };
}

export interface ParseOpts {
  /** Job output dir, used to point trajectories at each trial's logs. */
  jobDir: string;
  passThreshold: number;
  primaryReward?: string;
}

/**
 * Turn a Harbor JobResult into PerTaskResult[] — one entry per trial (so with
 * n_attempts > 1 a task appears once per attempt, making the split-level mean a
 * pass@1 average). Errored trials count as hard 0 / soft 0.
 */
export function parseJobResult(raw: unknown, opts: ParseOpts): PerTaskResult[] {
  const trials = (raw as any)?.trial_results;
  if (!Array.isArray(trials)) {
    throw new Error("harbor result.json has no trial_results array (unexpected JobResult shape)");
  }
  return trials.map((t: any): PerTaskResult => {
    const taskId = String(t.task_name ?? t.task_id?.path ?? "unknown");
    const rewards = normalizeRewards(t?.verifier_result?.rewards);
    const values = Object.values(rewards);
    const soft = values.length ? clamp01(mean(values)) : 0;
    const hard: 0 | 1 = isPass(rewards, opts) ? 1 : 0;
    const trajectory = t.trial_name ? path.join(opts.jobDir, String(t.trial_name)) : undefined;
    return { taskId, hard, soft, rewards, trajectory };
  });
}

// --- helpers ---------------------------------------------------------------

function normalizeRewards(src: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

function isPass(rewards: Record<string, number>, opts: ParseOpts): boolean {
  const values = Object.values(rewards);
  if (!values.length) return false;
  if (opts.primaryReward && opts.primaryReward in rewards) {
    return rewards[opts.primaryReward] >= opts.passThreshold;
  }
  return Math.min(...values) >= opts.passThreshold;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function defaultJobName(split: string): string {
  return `skillopt-${split}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function spawnHarbor(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`harbor timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new Error(`failed to spawn "${bin}": ${e.message}. Is the Harbor CLI installed (uv tool install harbor)?`)),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      // Harbor exits 0 even when individual trials error; we read result.json
      // regardless. A non-zero exit means the job could not run at all.
      if (code !== 0) {
        reject(new Error(`harbor exited ${code}: ${err.trim().slice(0, 800)}`));
        return;
      }
      resolve();
    });
  });
}
