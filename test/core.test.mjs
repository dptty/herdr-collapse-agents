import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLabel, buildViewParams, statusFilter } from "../src/core.mjs";

const agent = (pane_id, agent_status, state_change_seq) => ({ pane_id, agent_status, state_change_seq });
const manyOfEach = (n) =>
  ["blocked", "done", "working", "idle", "unknown"].flatMap((status) =>
    Array.from({ length: n }, (_, i) => agent(`${status}${i}`, status, i)),
  );

test("label counts each status in native priority order", () => {
  const agents = [
    agent("a", "idle", 1), agent("b", "working", 2), agent("c", "blocked", 3), agent("d", "idle", 4),
    agent("e", "done", 5), agent("f", "working", 6), agent("g", "idle", 7),
  ];
  assert.equal(buildLabel(agents), "×1 ✓1 ◐2 ○3");
});

test("label hides statuses with zero agents", () => {
  assert.equal(buildLabel([agent("a", "idle", 1), agent("b", "idle", 2)]), "○2");
});

test("label is 0 when there are no agents, because herdr rejects an empty label", () => {
  assert.equal(buildLabel([]), "0");
});

test("unrecognised statuses count as unknown", () => {
  assert.equal(buildLabel([agent("a", "sleeping", 1), agent("b", "unknown", 2)]), "·2");
});

test("label shows exact counts up to 999", () => {
  assert.equal(buildLabel(manyOfEach(999)), "×999 ✓999 ◐999 ○999 ·999");
});

test("label caps larger counts at 999+ and stays within herdr's 32-character limit", () => {
  const label = buildLabel(manyOfEach(10_000));
  assert.equal(label, "×999+ ✓999+ ◐999+ ○999+ ·999+");
  assert.ok([...label].length <= 32);
});

test("view params list only agents waiting on input by default", () => {
  const agents = [agent("w1:p1", "idle", 1), agent("w2:p3", "blocked", 2)];
  assert.deepEqual(buildViewParams(agents, "plugin:collapse-agents"), {
    source: "plugin:collapse-agents",
    label: "×1 ○1",
    filter: { op: "in", field: "status", values: ["blocked"] },
  });
});

test("view params keep the status filter when no agent matches", () => {
  assert.deepEqual(buildViewParams([agent("w1:p1", "working", 1)], "plugin:collapse-agents"), {
    source: "plugin:collapse-agents",
    label: "◐1",
    filter: statusFilter(["blocked"]),
  });
});

test("statuses picks which statuses the list shows", () => {
  const statuses = ["blocked", "done", "working"];
  assert.deepEqual(buildViewParams([agent("w1:p1", "idle", 1)], "plugin:collapse-agents", { statuses }).filter, {
    op: "in",
    field: "status",
    values: ["blocked", "done", "working"],
  });
});

test("show latest lists only the most recent agent with a chosen status", () => {
  const agents = [agent("w1:p1", "blocked", 5), agent("w2:p1", "done", 9), agent("w3:p1", "working", 12)];
  const statuses = ["blocked", "done"];
  assert.deepEqual(buildViewParams(agents, "plugin:collapse-agents", { show: "latest", statuses }).filter, {
    op: "all",
    filters: [{ op: "eq", field: "pane_id", value: "w2:p1" }, statusFilter(statuses)],
  });
});

const latestPane = (agents) =>
  buildViewParams(agents, "plugin:collapse-agents", { show: "latest" }).filter.filters[0].value;

test("show latest keeps the first agent on a state_change_seq tie", () => {
  assert.equal(latestPane([agent("first", "blocked", 7), agent("second", "blocked", 7)]), "first");
});

test("show latest treats a missing state_change_seq as 0", () => {
  assert.equal(latestPane([agent("no-seq", "blocked", undefined), agent("seq", "blocked", 1)]), "seq");
  assert.equal(latestPane([agent("no-seq", "blocked", undefined), agent("zero", "blocked", 0)]), "no-seq");
  assert.equal(latestPane([agent("zero", "blocked", 0), agent("no-seq", "blocked", undefined)]), "zero");
});

test("show latest with no matching agent keeps the live status filter", () => {
  const agents = [agent("w1:p1", "working", 5), agent("w2:p1", "idle", 9)];
  assert.deepEqual(buildViewParams(agents, "plugin:collapse-agents", { show: "latest", statuses: ["done"] }).filter, {
    op: "in",
    field: "status",
    values: ["done"],
  });
});

test("settings do not change the label", () => {
  const agents = [agent("w1:p1", "blocked", 5), agent("w2:p1", "idle", 9)];
  for (const settings of [{ show: "latest" }, { show: "all" }, { statuses: ["idle"] }]) {
    assert.equal(buildViewParams(agents, "plugin:collapse-agents", settings).label, "×1 ○1");
  }
});
