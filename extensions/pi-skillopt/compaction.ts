// Compaction summary. When pi auto-compacts the context mid-run, this rebuilds a
// compact briefing from the persisted session files so the loop survives the
// reset without re-reading skillopt.md / skillopt.jsonl in full.

import * as fs from "node:fs";
import * as path from "node:path";
import { reconstruct } from "./jsonl.ts";

export interface SkilloptSummaryPaths {
  md: string;
  jsonl: string;
}

export function skilloptSummaryPathsFor(workDir: string): SkilloptSummaryPaths {
  return {
    md: path.join(workDir, "skillopt.md"),
    jsonl: path.join(workDir, "skillopt.jsonl"),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function buildSkilloptCompactionSummary(paths: SkilloptSummaryPaths): string {
  const state = fs.existsSync(paths.jsonl) ? reconstruct(paths.jsonl) : null;
  const md = fs.existsSync(paths.md) ? fs.readFileSync(paths.md, "utf-8").trim() : "";

  const out: string[] = ["# SkillOpt Compaction Summary", ""];

  if (state) {
    const kept = state.steps.filter((s) => s.action !== "reject").length;
    out.push(
      "## Session",
      `Objective: ${state.name}`,
      `Gate metric: ${state.gateMetric}`,
      `Steps so far: ${state.steps.length} (${kept} accepted · ${state.steps.length - kept} rejected)`,
      `Best selection score: ${pct(state.bestScore)}`,
      "",
    );
    const recent = state.steps.slice(-5);
    if (recent.length) {
      out.push(`## Recent steps (last ${recent.length})`);
      for (const s of recent) {
        out.push(`#${s.step} ${s.action} — sel ${pct(state.gateMetric === "soft" ? s.sel_soft : s.sel_hard)} — ${s.edit}`);
      }
      out.push("");
    }
  }

  if (md) {
    out.push("## Session doc (skillopt.md)", md);
  }

  out.push(
    "",
    "## Loop reminder",
    "Continue: reflect on failing trajectories → apply <= edit_budget bounded edits → run_rollout('selection') → log_step. Never roll out 'test'. Never hardcode task answers into the skill.",
  );

  return out.join("\n");
}
