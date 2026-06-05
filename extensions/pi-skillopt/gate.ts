// Validation gate — the SkillOpt discipline that makes this "training" and not
// loose self-revision. Ported from microsoft/SkillOpt's gate.py: a candidate
// edit is accepted only if it STRICTLY improves the held-out selection score.
// A tie is rejected. This is objective arithmetic — the agent never decides.

import type { GateMetric, GateAction } from "./types.ts";

export function selectGateScore(
  hard: number,
  soft: number,
  metric: GateMetric = "hard",
  mixedWeight = 0.5,
): number {
  if (metric === "hard") return hard;
  if (metric === "soft") return soft;
  const w = Math.max(0, Math.min(1, mixedWeight));
  return (1 - w) * hard + w * soft;
}

export interface GateState {
  currentSkill: string;
  currentScore: number;
  bestSkill: string;
  bestScore: number;
  bestStep: number;
}

export interface GateOutcome extends GateState {
  action: GateAction;
}

/**
 * Pure gate decision. Three outcomes:
 *  - accept_new_best : beats both current and best  -> snapshot, update best_skill.md
 *  - accept          : beats current only           -> snapshot, current drifts up
 *  - reject          : ties or loses                -> revert skill to current
 */
export function evaluateGate(args: {
  candidateSkill: string;
  candHard: number;
  candSoft?: number;
  metric?: GateMetric;
  mixedWeight?: number;
  current: GateState;
  step: number;
}): GateOutcome {
  const {
    candidateSkill,
    candHard,
    candSoft = 0,
    metric = "hard",
    mixedWeight = 0.5,
    current,
    step,
  } = args;

  const cand = selectGateScore(candHard, candSoft, metric, mixedWeight);

  if (cand > current.currentScore) {
    if (cand > current.bestScore) {
      return {
        action: "accept_new_best",
        currentSkill: candidateSkill,
        currentScore: cand,
        bestSkill: candidateSkill,
        bestScore: cand,
        bestStep: step,
      };
    }
    return {
      action: "accept",
      currentSkill: candidateSkill,
      currentScore: cand,
      bestSkill: current.bestSkill,
      bestScore: current.bestScore,
      bestStep: current.bestStep,
    };
  }

  return { action: "reject", ...current };
}

/** Effective edit budget (learning rate) under a decay schedule. */
export function editBudgetAt(
  step: number,
  totalSteps: number,
  base: number,
  min: number,
  schedule: "constant" | "linear" | "cosine" = "cosine",
): number {
  if (schedule === "constant" || totalSteps <= 1) return base;
  const t = Math.min(1, Math.max(0, step / totalSteps));
  if (schedule === "linear") return Math.round(base + (min - base) * t);
  // cosine
  const cos = 0.5 * (1 + Math.cos(Math.PI * t));
  return Math.max(min, Math.round(min + (base - min) * cos));
}
