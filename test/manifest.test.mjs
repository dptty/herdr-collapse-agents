import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = await readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8").catch(() => "");
const REFRESH = 'command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]';

// Every event that can change the agent set, a status, "seen" (which the label counts), or a
// pane_id (which show = "latest" filters on).
const REQUIRED_EVENTS = [
  "pane.agent_status_changed",
  "pane.agent_detected",
  "pane.closed",
  "pane.exited",
  "pane.moved",
  "pane.focused",
  "tab.focused",
  "tab.closed",
  "tab.moved",
  "workspace.focused",
  "workspace.closed",
];

test("manifest hooks every event that can change the collapsed view", () => {
  const hooked = [...manifest.matchAll(/^on = "([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual([...hooked].sort(), [...REQUIRED_EVENTS].sort());
});

test("every event hook and the startup hook run refresh", () => {
  assert.match(manifest, /\[\[startup\]\]\ncommand = \["sh", "bin\/node-run", "src\/cli\.mjs", "refresh"\]/);
  assert.equal(manifest.split(REFRESH).length - 1, REQUIRED_EVENTS.length + 1);
});

test("the toggle action is declared", () => {
  assert.match(manifest, /^id = "collapse-agents"$/m);
  assert.match(manifest, /\[\[actions\]\]\nid = "toggle"[\s\S]*?command = \["sh", "bin\/node-run", "src\/cli\.mjs", "toggle"\]/);
});
