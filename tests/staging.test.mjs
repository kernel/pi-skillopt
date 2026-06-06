import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { stageInputs } from "../extensions/pi-skillopt/index.ts";

function setup() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "skillopt-stage-"));
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "source");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "fmt"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", "fmt", "SKILL.md"), "# seed skill\n");
  for (const t of ["t1", "t2"]) {
    fs.mkdirSync(path.join(source, "tasks", t), { recursive: true });
    fs.writeFileSync(path.join(source, "tasks", t, "task.toml"), `name = "x/${t}"\n`);
  }
  return { root, workspace, source };
}

test("stageInputs copies an external skill + task pack into the workspace and rewrites paths", () => {
  const { root, workspace, source } = setup();
  try {
    const cfg = {
      skillUnderTest: path.join(source, "skills", "fmt", "SKILL.md"),
      taskPack: path.join(source, "tasks"),
    };
    fs.writeFileSync(path.join(workspace, "skillopt.config.json"), JSON.stringify(cfg));

    stageInputs(workspace, cfg);

    // config paths rewritten to local copies
    assert.equal(cfg.skillUnderTest, "./skills/fmt/SKILL.md");
    assert.equal(cfg.taskPack, "./tasks");
    // local copies exist in the workspace
    assert.ok(fs.existsSync(path.join(workspace, "skills", "fmt", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(workspace, "tasks", "t1", "task.toml")));
    assert.ok(fs.existsSync(path.join(workspace, "tasks", "t2", "task.toml")));
    // the on-disk config was rewritten too
    const written = JSON.parse(fs.readFileSync(path.join(workspace, "skillopt.config.json"), "utf-8"));
    assert.equal(written.skillUnderTest, "./skills/fmt/SKILL.md");
    assert.equal(written.taskPack, "./tasks");
    // the source is left untouched
    assert.equal(fs.readFileSync(path.join(source, "skills", "fmt", "SKILL.md"), "utf-8"), "# seed skill\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stageInputs leaves inputs already inside the workspace untouched", () => {
  const { root, workspace } = setup();
  try {
    fs.mkdirSync(path.join(workspace, "skills", "fmt"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "skills", "fmt", "SKILL.md"), "# local\n");
    fs.mkdirSync(path.join(workspace, "tasks", "t1"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "tasks", "t1", "task.toml"), 'name = "x/t1"\n');
    const cfg = { skillUnderTest: "./skills/fmt/SKILL.md", taskPack: "./tasks" };
    const before = JSON.stringify(cfg);

    stageInputs(workspace, cfg);

    assert.equal(JSON.stringify(cfg), before); // paths unchanged
    assert.ok(!fs.existsSync(path.join(workspace, "skills", "fmt", "skills"))); // no nested re-copy
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
