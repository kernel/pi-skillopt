import assert from "node:assert/strict";
import test from "node:test";

import skilloptExtension from "../extensions/pi-skillopt/index.ts";

// Drive the extension with a mock ExtensionApi (no live pi) and capture what it
// wires up — the same pattern pi-autoresearch uses to test registration offline.
function collect() {
  const tools = [];
  const commands = [];
  const events = [];
  skilloptExtension({
    registerTool: (t) => tools.push(t.name),
    registerCommand: (name) => commands.push(name),
    on: (event) => events.push(event),
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendUserMessage: () => {},
    registerShortcut: () => {},
  });
  return { tools, commands, events };
}

test("registers the three gated tools", () => {
  const { tools } = collect();
  assert.deepEqual(tools.slice().sort(), ["init_optimization", "log_step", "run_rollout"]);
});

test("registers the /skillopt command", () => {
  const { commands } = collect();
  assert.deepEqual(commands, ["skillopt"]);
});

test("wires the session + loop lifecycle events", () => {
  const { events } = collect();
  for (const e of [
    "session_start",
    "agent_start",
    "agent_end",
    "before_agent_start",
    "session_before_compact",
    "session_compact",
    "session_shutdown",
  ]) {
    assert.ok(events.includes(e), `expected the extension to register on("${e}")`);
  }
});

test("returns its package name", () => {
  const ret = skilloptExtension({
    registerTool: () => {},
    registerCommand: () => {},
    on: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendUserMessage: () => {},
    registerShortcut: () => {},
  });
  assert.equal(ret.name, "pi-skillopt");
});
