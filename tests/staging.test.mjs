import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { stageInputs, applyTaskNamespace } from "../extensions/pi-skillopt/index.ts";

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

test("applyTaskNamespace swaps the task org but not author names, and is idempotent", () => {
  const d = fs.mkdtempSync(path.join(tmpdir(), "skillopt-ns-"));
  try {
    fs.mkdirSync(path.join(d, "t1"), { recursive: true });
    fs.writeFileSync(
      path.join(d, "t1", "task.toml"),
      'schema_version = "1.3"\n\n[task]\nname = "skillopt-hello/t1"\n[[task.authors]]\nname = "pi-skillopt"\n',
    );
    applyTaskNamespace(d, "kernel");
    let toml = fs.readFileSync(path.join(d, "t1", "task.toml"), "utf-8");
    assert.match(toml, /name = "kernel\/t1"/);
    assert.match(toml, /name = "pi-skillopt"/); // author name (no slash) untouched
    // idempotent
    applyTaskNamespace(d, "kernel");
    toml = fs.readFileSync(path.join(d, "t1", "task.toml"), "utf-8");
    assert.match(toml, /name = "kernel\/t1"/);
    assert.doesNotMatch(toml, /kernel\/kernel/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("stageInputs applies taskNamespace to the staged (copied) pack only", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "skillopt-ns2-"));
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "source");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "fmt"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", "fmt", "SKILL.md"), "# seed\n");
  fs.mkdirSync(path.join(source, "tasks", "t1"), { recursive: true });
  fs.writeFileSync(path.join(source, "tasks", "t1", "task.toml"), '[task]\nname = "skillopt-hello/t1"\n');
  try {
    const cfg = {
      skillUnderTest: path.join(source, "skills", "fmt", "SKILL.md"),
      taskPack: path.join(source, "tasks"),
      taskNamespace: "kernel",
    };
    fs.writeFileSync(path.join(workspace, "skillopt.config.json"), JSON.stringify(cfg));
    stageInputs(workspace, cfg);
    assert.match(fs.readFileSync(path.join(workspace, "tasks", "t1", "task.toml"), "utf-8"), /name = "kernel\/t1"/);
    // source pack untouched
    assert.match(fs.readFileSync(path.join(source, "tasks", "t1", "task.toml"), "utf-8"), /name = "skillopt-hello\/t1"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
