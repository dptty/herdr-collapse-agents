import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViewParams } from "../src/core.mjs";
import { refresh, toggle } from "../src/commands.mjs";
import { readCollapsed, writeCollapsed } from "../src/state.mjs";
import { startFakeHerdr } from "./fake-herdr.mjs";

const SOURCE = "plugin:collapse-agents";
const AGENTS = [
  { pane_id: "w1:p1", agent_status: "idle", state_change_seq: 1 },
  { pane_id: "w2:p1", agent_status: "blocked", state_change_seq: 2 },
];
const EXPECTED_VIEW = { source: SOURCE, label: "×1 ○1", filter: { op: "in", field: "status", values: ["blocked"] } };

const listResult = (agents) => ({ type: "agent_list", agents });
const viewResult = (method) => ({ type: "agent_view", active: method === "agent.view.set" });
const methods = (herdr) => herdr.requests.map((r) => r.method);
const lastSet = (herdr) => herdr.requests.filter((r) => r.method === "agent.view.set").at(-1)?.params;

// `configJson`, when given, is written to config.json in a plugin config dir.
async function setup(t, handler, configJson) {
  const herdr = await startFakeHerdr(handler);
  const stateDir = await mkdtemp(join(tmpdir(), "ca-cmd-"));
  const configDir = await mkdtemp(join(tmpdir(), "ca-cfg-"));
  t.after(async () => {
    await herdr.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });
  if (configJson !== undefined) await writeFile(join(configDir, "config.json"), configJson);
  const env = {
    HERDR_SOCKET_PATH: herdr.socketPath,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_ID: "collapse-agents",
  };
  return { herdr, stateDir, env };
}

const staticHandler = (method) => (method === "agent.list" ? listResult(AGENTS) : viewResult(method));

// n working agents: each n gives a different label, so the desired view keeps changing.
const working = (n) =>
  Array.from({ length: n }, (_, i) => ({ pane_id: `w1:p${i}`, agent_status: "working", state_change_seq: i }));

// A one-shot barrier: the fake herdr calls arrive() when a request reaches it, and holds the
// request until the test calls release(). This forces an exact interleaving.
function barrier() {
  let arrive;
  let release;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { arrived, released, arrive, release };
}

test("toggle from expanded saves collapsed, sets the view, and verifies it", async (t) => {
  const { herdr, stateDir, env } = await setup(t, staticHandler);
  assert.equal(await toggle(env), "collapsed");
  assert.deepEqual(herdr.requests, [
    { method: "agent.list", params: {} },
    { method: "agent.view.set", params: EXPECTED_VIEW },
    { method: "agent.list", params: {} },
  ]);
  assert.equal(await readCollapsed(stateDir), true);
});

test("toggle from collapsed saves expanded and clears only this plugin's view", async (t) => {
  const { herdr, stateDir, env } = await setup(t, staticHandler);
  await writeCollapsed(stateDir, true);
  assert.equal(await toggle(env), "expanded");
  assert.deepEqual(herdr.requests, [{ method: "agent.view.clear", params: { source: SOURCE } }]);
  assert.equal(await readCollapsed(stateDir), false);
});

test("toggle re-applies the view when an agent changes during the collapse", async (t) => {
  const later = [{ ...AGENTS[0], agent_status: "blocked", state_change_seq: 3 }, AGENTS[1]];
  let lists = 0;
  const { herdr, env } = await setup(t, (method) => {
    if (method !== "agent.list") return viewResult(method);
    lists += 1;
    return listResult(lists === 1 ? AGENTS : later);
  });
  assert.equal(await toggle(env), "collapsed");
  assert.deepEqual(methods(herdr), ["agent.list", "agent.view.set", "agent.list", "agent.view.set", "agent.list"]);
  assert.deepEqual(lastSet(herdr), buildViewParams(later, SOURCE));
});

test("refresh while expanded clears this plugin's view", async (t) => {
  const { herdr, env } = await setup(t, staticHandler);
  assert.equal(await refresh(env), "cleared");
  assert.deepEqual(herdr.requests, [{ method: "agent.view.clear", params: { source: SOURCE } }]);
});

test("refresh re-reads agents and re-points the view while collapsed", async (t) => {
  const { herdr, stateDir, env } = await setup(t, staticHandler);
  await writeCollapsed(stateDir, true);
  assert.equal(await refresh(env), "applied");
  assert.deepEqual(methods(herdr), ["agent.list", "agent.view.set", "agent.list"]);
  assert.deepEqual(lastSet(herdr), EXPECTED_VIEW);
});

test("an expand during a refresh wins", async (t) => {
  const held = barrier();
  let lists = 0;
  const { herdr, stateDir, env } = await setup(t, async (method) => {
    if (method !== "agent.list") return viewResult(method);
    lists += 1;
    if (lists === 1) {
      held.arrive();
      await held.released; // hold the refresh between its list and its set
    }
    return listResult(AGENTS);
  });
  await writeCollapsed(stateDir, true);
  const pending = refresh(env);
  await held.arrived; // the refresh saw "collapsed" and is now waiting for agents
  assert.equal(await toggle(env), "expanded");
  held.release();
  assert.equal(await pending, "cleared");
  assert.deepEqual(methods(herdr), ["agent.list", "agent.view.clear", "agent.view.set", "agent.view.clear"]);
});

test("a delayed stale write is repaired by its own re-check", async (t) => {
  const agentsAt = (version) => [
    ...Array.from({ length: version }, (_, i) => ({ pane_id: `w1:p${i}`, agent_status: "blocked", state_change_seq: i })),
    { pane_id: "w9:p9", agent_status: "idle", state_change_seq: 0 },
  ];
  const held = barrier();
  let version = 1;
  let lists = 0;
  const { herdr, stateDir, env } = await setup(t, async (method) => {
    if (method !== "agent.list") return viewResult(method);
    lists += 1;
    const snapshot = agentsAt(version);
    if (lists === 1) {
      held.arrive();
      await held.released; // the older hook keeps its old snapshot while a newer hook runs
    }
    return listResult(snapshot);
  });
  await writeCollapsed(stateDir, true);
  const older = refresh(env);
  await held.arrived;
  version = 2; // an agent changes, so herdr starts a newer hook
  assert.equal(await refresh(env), "applied");
  held.release();
  assert.equal(await older, "applied");
  assert.deepEqual(methods(herdr), [
    "agent.list", // older hook reads version 1, then is held
    "agent.list", "agent.view.set", "agent.list", // newer hook applies version 2 and settles
    "agent.view.set", "agent.list", // older hook overwrites with version 1, re-checks,
    "agent.view.set", "agent.list", // and repairs the view to version 2
  ]);
  assert.deepEqual(lastSet(herdr), buildViewParams(agentsAt(2), SOURCE));
});

test("an expand at the round cap still ends cleared", async (t) => {
  let lists = 0;
  let expanded;
  const { herdr, stateDir, env } = await setup(t, async (method) => {
    if (method !== "agent.list") return viewResult(method);
    lists += 1;
    // List 20 feeds the twentieth (last) apply. The user expands while it is in flight.
    if (lists === 20) expanded = await toggle(env);
    return listResult(working(lists));
  });
  await writeCollapsed(stateDir, true);
  assert.equal(await refresh(env), "cleared");
  assert.equal(expanded, "expanded");
  // The expand's clear, the refresh's last (stale) set, then the refresh's final clear.
  assert.deepEqual(methods(herdr).slice(-3), ["agent.view.clear", "agent.view.set", "agent.view.clear"]);
});

test("a clear at the round cap is re-checked like any other write", async (t) => {
  let lists = 0;
  let expanded;
  let collapsedAgain;
  const { herdr, stateDir, env } = await setup(t, async (method) => {
    if (method === "agent.list") {
      lists += 1;
      if (lists === 20) expanded = await toggle(env); // the user expands during the last round
      return listResult(working(Math.min(lists, 21))); // agents churn until the cap, then settle
    }
    // The fake can't pause between the refresh's flag read and its final clear, so the user
    // collapses again while that clear is in flight. The refresh's re-check must notice.
    if (method === "agent.view.clear" && expanded && collapsedAgain === undefined) {
      collapsedAgain = await toggle(env);
    }
    return viewResult(method);
  });
  await writeCollapsed(stateDir, true);
  assert.equal(await refresh(env), "unsettled");
  assert.equal(expanded, "expanded");
  assert.equal(collapsedAgain, "collapsed");
  // The refresh's final clear, then the second collapse's own list, set, and verify.
  assert.deepEqual(methods(herdr).slice(-4), ["agent.view.clear", "agent.list", "agent.view.set", "agent.list"]);
  assert.deepEqual(lastSet(herdr), buildViewParams(working(21), SOURCE));
});

test("refresh gives up after twenty rounds when agents never settle", async (t) => {
  let lists = 0;
  const { herdr, stateDir, env } = await setup(t, (method) => {
    if (method !== "agent.list") return viewResult(method);
    lists += 1;
    return listResult(working(lists));
  });
  await writeCollapsed(stateDir, true);
  assert.equal(await refresh(env), "unsettled");
  assert.equal(methods(herdr).filter((m) => m === "agent.view.set").length, 20);
});

test("a refresh whose agent.list fails rejects without writing", async (t) => {
  const { herdr, stateDir, env } = await setup(t, (method) =>
    method === "agent.list" ? { error: { code: "unavailable", message: "try again" } } : viewResult(method),
  );
  await writeCollapsed(stateDir, true);
  await assert.rejects(refresh(env), /unavailable/);
  assert.deepEqual(methods(herdr), ["agent.list"]); // the previous view stays until the next event
});

test("refresh honours show and statuses from the plugin config dir", async (t) => {
  const settings = { show: "latest", statuses: ["idle"] };
  const { herdr, stateDir, env } = await setup(t, staticHandler, JSON.stringify(settings));
  await writeCollapsed(stateDir, true);
  assert.equal(await refresh(env), "applied");
  assert.deepEqual(lastSet(herdr), buildViewParams(AGENTS, SOURCE, settings));
  assert.deepEqual(lastSet(herdr).filter.filters[0], { op: "eq", field: "pane_id", value: "w1:p1" });
});

test("an invalid show warns in the plugin log and shows all blocked agents", async (t) => {
  const { herdr, stateDir, env } = await setup(t, staticHandler, JSON.stringify({ show: "some" }));
  const stderr = t.mock.method(process.stderr, "write", () => true);
  await writeCollapsed(stateDir, true);
  assert.equal(await refresh(env), "applied");
  assert.deepEqual(lastSet(herdr), EXPECTED_VIEW);
  const written = stderr.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.match(written, /^collapse-agents: .*show.*"some"/m);
  assert.equal(written.split("collapse-agents:").length - 1, 1, "each warning is written once per process");
});

test("a refresh that started before a config edit converges onto the new settings", async (t) => {
  const held = barrier();
  let lists = 0;
  const { herdr, stateDir, env } = await setup(
    t,
    async (method) => {
      if (method !== "agent.list") return viewResult(method);
      lists += 1;
      if (lists === 1) {
        held.arrive();
        await held.released; // the older hook has read show = "all" and is waiting for agents
      }
      return listResult(AGENTS);
    },
    JSON.stringify({ show: "all" }),
  );
  await writeCollapsed(stateDir, true);
  const older = refresh(env);
  await held.arrived;
  await writeFile(join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json"), JSON.stringify({ show: "latest" }));
  assert.equal(await refresh(env), "applied"); // a newer hook applies "latest" and settles
  held.release();
  assert.equal(await older, "applied");
  assert.deepEqual(lastSet(herdr), buildViewParams(AGENTS, SOURCE, { show: "latest" }));
});

test("missing herdr environment is reported", async () => {
  await assert.rejects(refresh({}), /HERDR_SOCKET_PATH/);
  await assert.rejects(toggle({}), /HERDR_SOCKET_PATH/);
});
