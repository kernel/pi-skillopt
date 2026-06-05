// The Harbor seam.
//
// This is the ONLY module that knows how to talk to Harbor. Everything else in
// the plugin deals in skills, scores, and gate decisions. Swapping eval
// substrates later means rewriting only this file.
//
// A rollout = run the configured agent (claude-code / codex / pi / ...) inside
// the configured backend (docker / daytona / e2b / runloop / ...), with the
// CANDIDATE skill mounted and the rollout env pre-loaded, over a set of task
// ids, then read each task's verifier rewards back as a score.
//
// ADAPTER STATUS: the exact `harbor run` flags for skill-mounting and per-task
// reward extraction must be pinned against the installed Harbor CLI version
// (see https://github.com/harbor-framework/harbor and its cookbook). The shape
// below matches Harbor's documented surface — `harbor run -p <pack> -a <agent>
// -m <model> --json`, the `skills` recipe for injection, and `multi-reward`
// verifiers — and is contained entirely here on purpose.

import { spawn } from "node:child_process";
import type {
  RolloutEnv,
  RolloutResult,
  PerTaskResult,
  RolloutSetup,
} from "./types.ts";

export interface RolloutRequest {
  taskPack: string;
  skillPath: string;
  taskIds: string[];
  split: "train" | "selection" | "test";
  env: RolloutEnv;
  /** Up to this many failing trajectories are surfaced to the agent. Default 4. */
  sampleFailures?: number;
  /** Per-rollout timeout in seconds. Default 1800. */
  timeoutSeconds?: number;
  harborBin?: string;
}

/**
 * Translate the declarative RolloutSetup into the container provisioning Harbor
 * needs. Kept pure + separate so it can be unit-tested without spawning Harbor.
 */
export function buildContainerSetup(setup: RolloutSetup | undefined): string[] {
  if (!setup) return [];
  const cmds: string[] = [];
  if (setup.apt?.length) cmds.push(`apt-get update && apt-get install -y ${setup.apt.join(" ")}`);
  if (setup.npm?.length) cmds.push(`npm install -g ${setup.npm.join(" ")}`);
  if (setup.pip?.length) cmds.push(`pip install ${setup.pip.join(" ")}`);
  if (setup.commands?.length) cmds.push(...setup.commands);
  return cmds;
}

/** Build the `harbor run` argv from a rollout request. */
export function buildHarborArgs(req: RolloutRequest): string[] {
  const { taskPack, skillPath, taskIds, env } = req;
  const args = [
    "run",
    "-p", taskPack,
    "-a", String(env.agent),
    "-m", env.model,
    "--backend", env.backend,
    "--json",
  ];
  if (env.image) args.push("--image", env.image);

  // Mount the candidate skill + any companion skills (Harbor `skills` recipe).
  args.push("--skill", skillPath);
  for (const s of env.setup?.skills ?? []) args.push("--skill", s);

  // Pre-load steps and secret passthrough.
  for (const cmd of buildContainerSetup(env.setup)) args.push("--setup", cmd);
  for (const name of env.setup?.env ?? []) args.push("--secret", name);

  // Restrict the run to the split's task ids.
  if (taskIds.length) args.push("--tasks", taskIds.join(","));

  return args;
}

/**
 * Run a rollout and aggregate the per-task verifier rewards into a single
 * RolloutResult. `hard` is mean pass-rate; `soft` is mean reward.
 */
export async function runRollout(req: RolloutRequest): Promise<RolloutResult> {
  const bin = req.harborBin ?? "harbor";
  const args = buildHarborArgs(req);
  const raw = await spawnJson(bin, args, (req.timeoutSeconds ?? 1800) * 1000);
  const perTask = parseHarborOutput(raw);

  const hard = mean(perTask.map((t) => t.hard));
  const soft = mean(perTask.map((t) => t.soft));
  const failing = perTask
    .filter((t) => t.hard === 0)
    .slice(0, req.sampleFailures ?? 4);

  return { split: req.split, hard, soft, perTask, failing };
}

/**
 * Normalize Harbor's --json output into PerTaskResult[].
 *
 * ADAPTER: confirm the field names against the installed Harbor version. We
 * accept a couple of likely shapes and fail loudly if neither matches, rather
 * than silently scoring everything 0.
 */
export function parseHarborOutput(raw: unknown): PerTaskResult[] {
  const records = extractTaskRecords(raw);
  if (!records) {
    throw new Error(
      "harbor: could not locate per-task results in --json output (pin parseHarborOutput to the installed Harbor schema)",
    );
  }
  return records.map((r) => {
    const rewards = normalizeRewards(r);
    const values = Object.values(rewards);
    const soft = values.length ? mean(values) : Number(r.reward ?? r.score ?? 0);
    // hard = all required verifiers passed. If the run reports an explicit
    // pass/success use it; otherwise treat soft===1 (or >= threshold) as pass.
    const explicit = r.passed ?? r.success;
    const hard: 0 | 1 = explicit !== undefined ? (explicit ? 1 : 0) : soft >= 1 ? 1 : 0;
    return {
      taskId: String(r.id ?? r.task_id ?? r.task ?? "unknown"),
      hard,
      soft,
      rewards,
      trajectory: r.trajectory ?? r.atif ?? r.transcript,
    };
  });
}

// --- helpers ---------------------------------------------------------------

type LooseRecord = Record<string, any>;

function extractTaskRecords(raw: unknown): LooseRecord[] | null {
  if (Array.isArray(raw)) return raw as LooseRecord[];
  if (raw && typeof raw === "object") {
    const o = raw as LooseRecord;
    for (const key of ["results", "tasks", "runs", "evaluations"]) {
      if (Array.isArray(o[key])) return o[key] as LooseRecord[];
    }
  }
  return null;
}

function normalizeRewards(r: LooseRecord): Record<string, number> {
  const out: Record<string, number> = {};
  const src = r.rewards ?? r.verifiers ?? r.scores;
  if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) {
      const n = typeof v === "number" ? v : Number((v as any)?.score ?? (v as any)?.reward);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function spawnJson(bin: string, args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`harbor timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn "${bin}": ${e.message}. Is the Harbor CLI installed (uv tool install harbor)?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`harbor exited ${code}: ${err.trim().slice(0, 800)}`));
        return;
      }
      try {
        resolve(JSON.parse(lastJsonBlock(out)));
      } catch {
        reject(new Error(`harbor: could not parse JSON output. First 400 chars:\n${out.slice(0, 400)}`));
      }
    });
  });
}

/** Harbor may print progress before the JSON payload; take the last {...} or [...] block. */
function lastJsonBlock(s: string): string {
  const trimmed = s.trim();
  const lastObj = trimmed.lastIndexOf("\n{");
  const lastArr = trimmed.lastIndexOf("\n[");
  const idx = Math.max(lastObj, lastArr);
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
