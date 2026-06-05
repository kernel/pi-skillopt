import assert from "node:assert/strict";
import test from "node:test";

import { makeSplits, assertDisjoint } from "../extensions/pi-skillopt/splits.ts";

const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);

test("makeSplits partitions by ratio and is deterministic", () => {
  const a = makeSplits(ids, "60:20:20");
  const b = makeSplits(ids, "60:20:20");
  assert.deepEqual(a, b);
  assert.equal(a.train.length, 6);
  assert.equal(a.selection.length, 2);
  assert.equal(a.test.length, 2);
});

test("splits are disjoint and cover every id", () => {
  const s = makeSplits(ids, "60:20:20");
  assertDisjoint(s);
  const all = [...s.train, ...s.selection, ...s.test].sort();
  assert.deepEqual(all, [...ids].sort());
});

test("assertDisjoint throws on leakage between splits", () => {
  assert.throws(() => assertDisjoint({ train: ["x"], selection: ["x"], test: [] }), /disjoint/);
});

test("an invalid ratio is rejected", () => {
  assert.throws(() => makeSplits(["a"], "nope"), /ratio/);
});
