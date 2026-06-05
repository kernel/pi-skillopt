// Append-only session log. skillopt.jsonl is the source of truth: a fresh agent
// (after a restart or context reset) reconstructs the whole run from it.

import * as fs from "node:fs";
import type { JsonlEntry, StepEntry, ConfigHeaderEntry, GateMetric } from "./types.ts";

export function appendEntry(path: string, entry: JsonlEntry): void {
  fs.appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function readEntries(path: string): JsonlEntry[] {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => safeParse(l))
    .filter((e): e is JsonlEntry => e !== null);
}

export interface ReconstructedState {
  name: string;
  skillUnderTest: string;
  taskPack: string;
  gateMetric: GateMetric;
  segment: number;
  steps: StepEntry[];
  currentScore: number;
  bestScore: number;
  bestStep: number;
}

/** Rebuild run state from the jsonl. Later config headers start a new segment. */
export function reconstruct(path: string): ReconstructedState | null {
  const entries = readEntries(path);
  if (entries.length === 0) return null;

  let header: ConfigHeaderEntry | null = null;
  let segment = 0;
  const steps: StepEntry[] = [];
  for (const e of entries) {
    if (e.type === "config") {
      header = e;
      segment += 1;
    } else if (e.type === "step") {
      steps.push(e);
    }
  }
  if (!header) return null;

  const inSegment = steps.filter((s) => s.segment === segment - 1 || s.segment === segment);
  const last = inSegment[inSegment.length - 1];
  return {
    name: header.name,
    skillUnderTest: header.skill_under_test,
    taskPack: header.task_pack,
    gateMetric: header.gate_metric,
    segment,
    steps,
    currentScore: last?.current_score ?? 0,
    bestScore: Math.max(0, ...inSegment.map((s) => s.best_score)),
    bestStep: last?.step ?? 0,
  };
}

/** Median Absolute Deviation noise floor over selection scores; null if < 3 points. */
export function confidence(steps: StepEntry[], metricKey: "sel_hard" | "sel_soft", baseline: number, best: number): number | null {
  const vals = steps.map((s) => s[metricKey]).filter((v) => Number.isFinite(v));
  if (vals.length < 3) return null;
  const med = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - med)));
  if (mad === 0) return null;
  return Math.abs(best - baseline) / mad;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function safeParse(line: string): JsonlEntry | null {
  try {
    const o = JSON.parse(line);
    return o && (o.type === "step" || o.type === "config") ? o : null;
  } catch {
    return null;
  }
}
