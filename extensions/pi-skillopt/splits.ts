// Train / selection / test split bookkeeping.
//
// The split discipline is what keeps the loop honest:
//  - train     : rollouts the agent reflects on to PROPOSE edits
//  - selection : held-out set the gate scores candidates on (never reflected on)
//  - test      : touched ONCE, by skillopt-finalize, for the headline number
//
// The extension enforces the separation; the agent cannot peek at test.

import type { Splits } from "./types.ts";

/** Deterministic split of task ids by ratio "train:selection:test" (e.g. "60:20:20"). */
export function makeSplits(taskIds: string[], ratio: string, seed = 0): Splits {
  const parts = ratio.split(/[:/]/).map((n) => Number(n.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`invalid split ratio "${ratio}" — expected e.g. "60:20:20"`);
  }
  const shuffled = seededShuffle([...taskIds], seed);
  const total = parts[0] + parts[1] + parts[2] || 1;
  const nTrain = Math.floor((parts[0] / total) * shuffled.length);
  const nSel = Math.floor((parts[1] / total) * shuffled.length);
  return {
    train: shuffled.slice(0, nTrain),
    selection: shuffled.slice(nTrain, nTrain + nSel),
    test: shuffled.slice(nTrain + nSel),
  };
}

/** Throw if any task id appears in more than one split (leakage guard). */
export function assertDisjoint(splits: Splits): void {
  const seen = new Map<string, string>();
  for (const name of ["train", "selection", "test"] as const) {
    for (const id of splits[name]) {
      const prev = seen.get(id);
      if (prev) {
        throw new Error(`task "${id}" is in both ${prev} and ${name} splits — splits must be disjoint`);
      }
      seen.set(id, name);
    }
  }
}

// Mulberry32 — small deterministic PRNG so a given (ids, seed) always splits the same.
function seededShuffle<T>(arr: T[], seed: number): T[] {
  let a = (seed >>> 0) || 1;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
