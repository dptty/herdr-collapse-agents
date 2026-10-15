# collapse-agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A herdr plugin whose `toggle` action collapses the sidebar Agents list. Collapsed, the header shows a status rollup and the list shows only agents with chosen statuses (by default, those waiting on input): all of them, or only the latest, set by the `statuses` and `show` settings. Toggling again restores the user's normal sort mode.

**Architecture:** The plugin drives herdr's `agent.view.set` / `agent.view.clear` socket methods.
- **Core:** a pure module builds the rollup label from `agent.list`, and a filter chosen by `statuses` and `show`. The default, `status in [blocked]`, is evaluated live by herdr.
- **Config:** `config.json` in the plugin config dir is re-read on every convergence round. Bad or unreadable files fall back to defaults, with one warning per process in the plugin log.
- **State:** a collapsed flag in the plugin state dir is the user's intent and survives restarts.
- **Hooks:** they run concurrently and use no lock. Every `refresh` converges, in both states: apply the desired state, re-check, and repeat while it changed.
- **Launcher:** every manifest command runs through a POSIX sh launcher that finds node even under a Homebrew service's minimal PATH.

**Tech Stack:** Node ≥ 18 ESM (`.mjs`), `node:test`, `node:net` Unix socket, POSIX sh, herdr ≥ 0.9.1 plugin v1 manifest. Zero dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-14-collapse-agents-design.md`. Read its "What herdr allows" and "Environment requirements" sections before starting.

**Provenance:** each task's commit adds its files exactly as the code blocks below show them. Following the plan reproduces the plugin byte for byte.

## Global Constraints

- **Toolchain:** Node ≥ 18, ESM `.mjs` files, zero dependencies, no build step.
- **Manifest:** `min_herdr_version = "0.9.1"`; `platforms = ["linux", "macos"]`. Every command is `["sh", "bin/node-run", "src/cli.mjs", <command>]`.
- **Names:** plugin id `collapse-agents`; action id `toggle`. The view source is `plugin:<HERDR_PLUGIN_ID>`, falling back to `plugin:collapse-agents`.
- **Label:** for each non-zero status in the order blocked `×`, done `✓`, working `◐`, idle `○`, unknown `·`, the glyph plus the count, separated by spaces, e.g. `×1 ✓1 ◐2 ○3`.
  - Counts above 999 show as `999+`.
  - No agents → `0`, because herdr rejects an empty label.
  - The label must stay ≤ 32 characters.
  - Unknown status strings count as `unknown`.
- **Filter:** set by `statuses` and `show`, and never with a `sort`. The status filter is `{"op":"in","field":"status","values":<statuses>}`:
  - `show = "all"` (the default) → the status filter;
  - `show = "latest"` → `{"op":"all","filters":[{"op":"eq","field":"pane_id","value":<the agent with the highest state_change_seq whose agent_status is in statuses>}, <status filter>]}`, or the plain status filter when no agent matches. Ties keep the first agent; a missing seq counts as 0.
- **Settings file:** `$HERDR_PLUGIN_CONFIG_DIR/config.json`, holding `{ "statuses": [...], "show": "all" | "latest" }`.
  - `statuses` is a non-empty list of `blocked`, `done`, `working`, `idle`, `unknown`, deduplicated into that order; default `["blocked"]`.
  - `show` defaults to `"all"`.
  - A missing file means defaults. An invalid value falls back to that key's default with a warning, and the keys are checked independently. `show_blocked`, the old name of `show`, is ignored with a warning.
  - If the file is unreadable or invalid, use the defaults. Write each warning to stderr as `collapse-agents: <warning>`, once per process. Re-read the file on every convergence round.
- **Convergence:** at most 20 apply rounds per process.
  - Out of rounds with the latest desired state expanded: apply the clear, re-check the flag, and return `cleared` only if it still says expanded.
  - Every other out-of-rounds case returns `unsettled`.
  - `refresh` converges even when expanded (one clear, no `agent.list`).
- **Socket:** requests have an absolute 3 s deadline.
- **Config:** the plugin never edits the user's `config.toml`.
- **Live verification:** never restart or upgrade the user's herdr server, because it hosts their running agents.
- **Commits:** one per task.

## Review Focus

- **An older hook's write lands after a newer hook has finished:** the older hook's re-check must repair the view → Task 5, "a delayed stale write is repaired by its own re-check" (barriers force the order).
- **An expand lands between a refresh's `agent.list` and its `agent.view.set`:** the view must end up cleared → Task 5, "an expand during a refresh wins".
- **An expand lands just before a process's twentieth (last) apply:** the view must still end up cleared → Task 5, "an expand at the round cap still ends cleared". A collapse during that final clear must make the process report `unsettled` → "a clear at the round cap is re-checked like any other write".
- **herdr is down, hung, trickling bytes, or returning an error:** the request must fail within its deadline → Task 4, the timeout/trickle/ENOENT/error tests.
- **`config.json` is edited while hooks are in flight:** a process that read the old setting must converge onto the new one → Task 5, "a refresh that started before a config edit converges onto the new settings".
- **`config.json` is broken, unreadable, or has an invalid `statuses`, `show` or the old `show_blocked`:** the plugin must still work with the defaults and say why in the plugin log → Task 3 (the config tests) and Task 5 ("an invalid show warns in the plugin log and shows all blocked agents").
- **herdr's server runs with a minimal PATH, so `node` isn't on it:** the launcher must still find node, or fail with exit 127 and a clear message → Task 6.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | `type: module`, `npm test` script, engines |
| `herdr-plugin.toml` | Manifest: `toggle` action, startup hook, 11 event hooks |
| `bin/node-run` | POSIX sh launcher: finds node under a minimal PATH |
| `src/core.mjs` | Pure: rollup label, the status and `"latest"` filters, view params |
| `src/config.mjs` | Reads and validates `config.json` from the plugin config dir |
| `src/state.mjs` | Collapsed flag file, atomic writes |
| `src/herdr-client.mjs` | One-shot newline-JSON request over herdr's Unix socket |
| `src/commands.mjs` | `toggle` and `refresh` via convergence |
| `src/cli.mjs` | argv entrypoint used by the manifest |
| `test/fake-herdr.mjs` | In-process fake herdr socket server for tests |
| `test/*.test.mjs` | Tests per module, the launcher, and the manifest |
| `README.md` | Install, keybinding, behaviour, limitations |

---

### Task 1: Pure core

**Files:**
- Create: `package.json`
- Create: `src/core.mjs`
- Test: `test/core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (agents are `agent.list` records: `{ pane_id: string, agent_status: string, state_change_seq?: number }`):
  - `STATUS_ORDER: string[]` = `["blocked","done","working","idle","unknown"]`
  - `GLYPHS: Record<string,string>`
  - `statusFilter(statuses: string[])` = `{ op: "in", field: "status", values: statuses }`
  - `normalizeStatus(status: string): string`
  - `buildLabel(agents): string`
  - `buildViewParams(agents, source: string, { show = "all", statuses = ["blocked"] }: { show?: "all" | "latest", statuses?: string[] } = {}): { source, label, filter }`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "collapse-agents",
  "version": "0.1.0",
  "private": true,
  "license": "0BSD",
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test test/*.test.mjs" }
}
```

- [ ] **Step 2: Write the failing tests** in `test/core.test.mjs`

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `ERR_MODULE_NOT_FOUND` for `src/core.mjs`.

- [ ] **Step 4: Write `src/core.mjs`**

```js
// Pure logic, no I/O. Agents are records from herdr's `agent.list` result.

export const STATUS_ORDER = ["blocked", "done", "working", "idle", "unknown"];

export const GLYPHS = {
  blocked: "×",
  done: "✓",
  working: "◐",
  idle: "○",
  unknown: "·",
};

// herdr rejects labels over 32 chars; 5 × "×999+" plus 4 spaces is 29.
const MAX_SHOWN_COUNT = 999;

// herdr also rejects an empty label, which no agents at all would give.
const NO_AGENTS_LABEL = "0";

export function normalizeStatus(status) {
  return STATUS_ORDER.includes(status) ? status : "unknown";
}

function formatCount(count) {
  return count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : String(count);
}

export function buildLabel(agents) {
  const counts = new Map(STATUS_ORDER.map((status) => [status, 0]));
  for (const agent of agents) {
    const status = normalizeStatus(agent.agent_status);
    counts.set(status, counts.get(status) + 1);
  }
  const parts = STATUS_ORDER.filter((status) => counts.get(status) > 0).map(
    (status) => `${GLYPHS[status]}${formatCount(counts.get(status))}`,
  );
  return parts.length > 0 ? parts.join(" ") : NO_AGENTS_LABEL;
}

// Collapsed, the list shows only agents with one of these statuses. herdr re-evaluates the
// filter live, against each client's own done/idle, so agents appear and disappear without
// the plugin having to re-apply the view.
export function statusFilter(statuses) {
  return { op: "in", field: "status", values: statuses };
}

// show = "latest": the matching agent with the most recent state change, picked from the
// server's statuses. The status filter also drops the row the moment the client stops
// matching it. With nothing matching, keep the live status filter so a newly matching agent
// appears before the next hook.
function latestFilter(agents, statuses) {
  let latest = null;
  for (const agent of agents) {
    if (!statuses.includes(agent.agent_status)) continue;
    if (latest === null || (agent.state_change_seq ?? 0) > (latest.state_change_seq ?? 0)) latest = agent;
  }
  if (latest === null) return statusFilter(statuses);
  return { op: "all", filters: [{ op: "eq", field: "pane_id", value: latest.pane_id }, statusFilter(statuses)] };
}

export function buildViewParams(agents, source, { show = "all", statuses = ["blocked"] } = {}) {
  const filter = show === "latest" ? latestFilter(agents, statuses) : statusFilter(statuses);
  return { source, label: buildLabel(agents), filter };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json src/core.mjs test/core.test.mjs
git commit -m "feat: add status rollup label and view params"
```

---

### Task 2: Collapsed flag

**Files:**
- Create: `src/state.mjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `readCollapsed(stateDir: string): Promise<boolean>`. A missing or corrupt file reads as `false`.
  - `writeCollapsed(stateDir: string, collapsed: boolean): Promise<void>`. Atomic: writes a uniquely named temp file, then renames it over `state.json`. Safe with concurrent writers in one process or several.

- [ ] **Step 1: Write the failing tests** in `test/state.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCollapsed, writeCollapsed } from "../src/state.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "ca-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("collapsed defaults to false when nothing was saved", async (t) => {
  assert.equal(await readCollapsed(await tempDir(t)), false);
});

test("collapsed round-trips through the state file", async (t) => {
  const dir = await tempDir(t);
  await writeCollapsed(dir, true);
  assert.equal(await readCollapsed(dir), true);
  await writeCollapsed(dir, false);
  assert.equal(await readCollapsed(dir), false);
});

test("a corrupt state file reads as expanded", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "state.json"), "{not json");
  assert.equal(await readCollapsed(dir), false);
});

test("writing leaves no temp files behind", async (t) => {
  const dir = await tempDir(t);
  await writeCollapsed(dir, true);
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("concurrent writes leave one valid state file", async (t) => {
  const dir = await tempDir(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => writeCollapsed(dir, i % 2 === 0)));
  assert.deepEqual(await readdir(dir), ["state.json"]);
  const saved = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(saved), ["collapsed"]);
  assert.equal(typeof saved.collapsed, "boolean");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `ERR_MODULE_NOT_FOUND` for `src/state.mjs`. The core tests still pass.

- [ ] **Step 3: Write `src/state.mjs`**

```js
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STATE_FILE = "state.json";

export async function readCollapsed(stateDir) {
  try {
    const state = JSON.parse(await readFile(join(stateDir, STATE_FILE), "utf8"));
    return state.collapsed === true;
  } catch {
    return false;
  }
}

export async function writeCollapsed(stateDir, collapsed) {
  const target = join(stateDir, STATE_FILE);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ collapsed }) + "\n");
  await rename(tmp, target);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state.mjs test/state.test.mjs
git commit -m "feat: persist the collapsed flag atomically"
```

---

### Task 3: Plugin config

**Files:**
- Create: `src/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: `STATUS_ORDER` (Task 1).
- Produces:
  - `DEFAULT_CONFIG` = `{ show: "all", statuses: ["blocked"] }`
  - `readConfig(configDir: string | undefined): Promise<{ show: "all" | "latest", statuses: string[], warnings: string[] }>`. Never throws.
    - With no dir or no file, it returns the defaults with no warnings.
    - If the file can't be read (any error but `ENOENT`) or isn't a JSON object, it returns the defaults with one warning.
    - An invalid `show` or `statuses` falls back to that key's default with one warning each. `statuses` comes back deduplicated in `STATUS_ORDER` order. A `show_blocked` key adds one warning and is otherwise ignored.

- [ ] **Step 1: Write the failing tests** in `test/config.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, readConfig } from "../src/config.mjs";

async function configDir(t, content) {
  const dir = await mkdtemp(join(tmpdir(), "ca-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (content !== undefined) await writeFile(join(dir, "config.json"), content);
  return dir;
}

test("defaults to showing all blocked agents", () => {
  assert.deepEqual(DEFAULT_CONFIG, { show: "all", statuses: ["blocked"] });
});

test("a missing config file gives the defaults without warnings", async (t) => {
  assert.deepEqual(await readConfig(await configDir(t)), { ...DEFAULT_CONFIG, warnings: [] });
});

test("no config dir gives the defaults without warnings", async () => {
  assert.deepEqual(await readConfig(undefined), { ...DEFAULT_CONFIG, warnings: [] });
});

test("show accepts all and latest", async (t) => {
  for (const value of ["all", "latest"]) {
    const dir = await configDir(t, JSON.stringify({ show: value }));
    assert.deepEqual(await readConfig(dir), { show: value, statuses: ["blocked"], warnings: [] });
  }
});

test("an unknown show value falls back to all with a warning, leaving statuses alone", async (t) => {
  const { warnings, ...config } = await readConfig(await configDir(t, '{ "show": "some", "statuses": ["done", "working"] }'));
  assert.deepEqual(config, { show: "all", statuses: ["done", "working"] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /show.*"some".*expected one of all, latest/);
});

test("statuses accepts any non-empty set, deduplicated into priority order", async (t) => {
  const dir = await configDir(t, JSON.stringify({ statuses: ["working", "done", "blocked", "done"] }));
  assert.deepEqual(await readConfig(dir), { show: "all", statuses: ["blocked", "done", "working"], warnings: [] });
});

test("an invalid statuses falls back to blocked with a warning, leaving show alone", async (t) => {
  for (const statuses of [[], "blocked", ["blocked", "finished"], [1], null]) {
    const dir = await configDir(t, JSON.stringify({ statuses, show: "latest" }));
    const config = await readConfig(dir);
    assert.deepEqual(config.statuses, ["blocked"]);
    assert.equal(config.show, "latest");
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0], /statuses.*expected a non-empty list of blocked, done, working, idle, unknown/);
  }
});

test("the old show_blocked key is ignored with a warning that it was renamed", async (t) => {
  for (const [content, expected] of [
    [{ show_blocked: "latest" }, { show: "all", statuses: ["blocked"] }],
    [{ show: "all", show_blocked: "latest", statuses: ["working"] }, { show: "all", statuses: ["working"] }],
    [{ show: "latest", show_blocked: "all" }, { show: "latest", statuses: ["blocked"] }],
  ]) {
    const { warnings, ...config } = await readConfig(await configDir(t, JSON.stringify(content)));
    assert.deepEqual(config, expected);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /show_blocked.*renamed to show/);
  }
});

test("a config file that isn't a JSON object falls back to the defaults with a warning", async (t) => {
  for (const content of ["{ not json", "[]", '"all"']) {
    const { warnings, ...config } = await readConfig(await configDir(t, content));
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /config\.json/);
  }
});

test("a config file that can't be read falls back to the defaults with a warning", async (t) => {
  const dir = await configDir(t);
  await mkdir(join(dir, "config.json")); // a directory where the file should be
  const { warnings, ...config } = await readConfig(dir);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /can't read config\.json/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `ERR_MODULE_NOT_FOUND` for `src/config.mjs`. The other 19 tests pass.

- [ ] **Step 3: Write `src/config.mjs`**

```js
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { STATUS_ORDER } from "./core.mjs";

// User settings live in "$HERDR_PLUGIN_CONFIG_DIR/config.json"; herdr leaves the format to us.
const CONFIG_FILE = "config.json";
const SHOW = ["all", "latest"];

export const DEFAULT_CONFIG = { show: "all", statuses: ["blocked"] };

// A non-empty list of known statuses, deduplicated into priority order; anything else is null.
function parseStatuses(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((status) => STATUS_ORDER.includes(status))) return null;
  return STATUS_ORDER.filter((status) => value.includes(status));
}

// Never throws: a missing file means defaults, and a bad one means defaults plus warnings.
export async function readConfig(configDir) {
  if (!configDir) return { ...DEFAULT_CONFIG, warnings: [] };
  let text;
  try {
    text = await readFile(join(configDir, CONFIG_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULT_CONFIG, warnings: [] };
    return { ...DEFAULT_CONFIG, warnings: [`can't read ${CONFIG_FILE}: ${error.message}`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ...DEFAULT_CONFIG, warnings: [`ignoring ${CONFIG_FILE}: ${error.message}`] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG, warnings: [`ignoring ${CONFIG_FILE}: expected a JSON object`] };
  }
  const config = { ...DEFAULT_CONFIG, warnings: [] };
  if (raw.show !== undefined) {
    if (SHOW.includes(raw.show)) config.show = raw.show;
    else {
      config.warnings.push(
        `ignoring show ${JSON.stringify(raw.show)} in ${CONFIG_FILE}; expected one of ${SHOW.join(", ")}`,
      );
    }
  }
  if (raw.statuses !== undefined) {
    const statuses = parseStatuses(raw.statuses);
    if (statuses) config.statuses = statuses;
    else {
      config.warnings.push(
        `ignoring statuses ${JSON.stringify(raw.statuses)} in ${CONFIG_FILE}; expected a non-empty list of ${STATUS_ORDER.join(", ")}`,
      );
    }
  }
  if (raw.show_blocked !== undefined) {
    config.warnings.push(`ignoring show_blocked in ${CONFIG_FILE}; it was renamed to show`);
  }
  return config;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat: read statuses and show from the plugin config dir"
```

---

### Task 4: herdr socket client

**Files:**
- Create: `src/herdr-client.mjs`
- Create: `test/fake-herdr.mjs`
- Test: `test/herdr-client.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class HerdrError extends Error { code: string }`, with message `"<code>: <message>"`.
  - `request(socketPath: string, method: string, params: object, opts?: { timeoutMs = 3000 }): Promise<object>`.
    - Resolves the response's `result`.
    - Rejects with `HerdrError` on an `error` response.
    - Rejects with an `Error` when the connection fails, when the absolute deadline passes (`/did not answer <method>/`), or when the connection closes before answering.
  - Test helper `startFakeHerdr(handler): Promise<{ socketPath, requests: {method, params}[], close(): Promise<void> }>`.
    - `handler(method, params)` may be async. It returns a result object, `{ error: { code, message } }`, or `undefined` to never answer.
    - Each request is recorded when it arrives, before the handler runs. That is the order herdr applies requests in.

- [ ] **Step 1: Write the test helper** `test/fake-herdr.mjs`

```js
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stands in for herdr's socket: answers each newline-delimited JSON request with one line.
export async function startFakeHerdr(handler) {
  const dir = await mkdtemp(join(tmpdir(), "ca-"));
  const socketPath = join(dir, "herdr.sock");
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        requests.push({ method: message.method, params: message.params });
        const reply = await handler(message.method, message.params);
        if (reply === undefined || socket.destroyed) continue;
        const body = reply.error ? { id: message.id, error: reply.error } : { id: message.id, result: reply };
        socket.write(JSON.stringify(body) + "\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 2: Write the failing tests** in `test/herdr-client.test.mjs`

The trickle test has its own `timeout` option. An inactivity-based timeout never fires in that case, so without the option the suite would hang instead of failing. `rawServer` destroys every accepted socket on teardown, so a broken client fails the test instead of keeping the process alive.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, request } from "../src/herdr-client.mjs";
import { startFakeHerdr } from "./fake-herdr.mjs";

async function rawServer(t, onConnection) {
  const dir = await mkdtemp(join(tmpdir(), "ca-"));
  const socketPath = join(dir, "raw.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return socketPath;
}

test("request sends method and params and resolves the result", async (t) => {
  const herdr = await startFakeHerdr(() => ({ type: "agent_list", agents: [] }));
  t.after(() => herdr.close());
  assert.deepEqual(await request(herdr.socketPath, "agent.list", {}), { type: "agent_list", agents: [] });
  assert.deepEqual(herdr.requests, [{ method: "agent.list", params: {} }]);
});

test("an error response rejects with herdr's code", async (t) => {
  const herdr = await startFakeHerdr(() => ({ error: { code: "plugin_not_found", message: "plugin not found" } }));
  t.after(() => herdr.close());
  await assert.rejects(request(herdr.socketPath, "agent.view.set", {}), (error) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "plugin_not_found");
    assert.equal(error.message, "plugin_not_found: plugin not found");
    return true;
  });
});

test("a herdr that never answers times out", async (t) => {
  const herdr = await startFakeHerdr(() => undefined);
  t.after(() => herdr.close());
  await assert.rejects(request(herdr.socketPath, "agent.list", {}, { timeoutMs: 100 }), /did not answer agent\.list/);
});

test("a herdr that trickles bytes without finishing still times out", { timeout: 2000 }, async (t) => {
  const socketPath = await rawServer(t, (socket) => {
    const interval = setInterval(() => socket.write(" "), 20);
    socket.on("close", () => clearInterval(interval));
  });
  const started = Date.now();
  await assert.rejects(request(socketPath, "agent.list", {}, { timeoutMs: 150 }), /did not answer agent\.list/);
  assert.ok(Date.now() - started < 1000);
});

test("a missing socket rejects", async () => {
  await assert.rejects(request("/nonexistent/herdr.sock", "agent.list", {}), /ENOENT/);
});

test("a glyph split across socket reads decodes intact", async (t) => {
  const reply = Buffer.from(JSON.stringify({ id: "x", result: { label: "✓1" } }) + "\n");
  const cut = reply.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte ✓
  const socketPath = await rawServer(t, (socket) => {
    socket.once("data", async () => {
      socket.write(reply.subarray(0, cut));
      await new Promise((resolve) => setTimeout(resolve, 20));
      socket.end(reply.subarray(cut));
    });
  });
  assert.deepEqual(await request(socketPath, "agent.view.set", {}), { label: "✓1" });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `ERR_MODULE_NOT_FOUND` for `src/herdr-client.mjs`.

- [ ] **Step 4: Write `src/herdr-client.mjs`**

```js
import net from "node:net";

export class HerdrError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "HerdrError";
    this.code = code;
  }
}

let nextId = 0;

// One request per connection: herdr answers each newline-delimited JSON request with one line.
export function request(socketPath, method, params, { timeoutMs = 3000 } = {}) {
  const id = `collapse-agents:${process.pid}:${++nextId}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const settle = (finish, value) => {
      clearTimeout(deadline);
      socket.destroy();
      finish(value);
    };
    // An absolute deadline, not socket.setTimeout: a peer trickling bytes must not hold us forever.
    const deadline = setTimeout(
      () => settle(reject, new Error(`herdr did not answer ${method} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    let buffer = "";
    socket.setEncoding("utf8"); // decodes multibyte glyphs split across reads
    socket.on("error", (error) => settle(reject, error));
    socket.on("close", () => settle(reject, new Error(`herdr closed the connection before answering ${method}`)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        settle(reject, error);
        return;
      }
      if (response.error) settle(reject, new HerdrError(response.error.code, response.error.message));
      else settle(resolve, response.result);
    });
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 35 tests.

- [ ] **Step 6: Commit**

```bash
git add src/herdr-client.mjs test/fake-herdr.mjs test/herdr-client.test.mjs
git commit -m "feat: add herdr socket client with an absolute deadline"
```

---

### Task 5: toggle and refresh via convergence, plus the CLI

**Files:**
- Create: `src/commands.mjs`
- Create: `src/cli.mjs`
- Test: `test/commands.test.mjs`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `buildViewParams` (Task 1); `readCollapsed`, `writeCollapsed` (Task 2); `readConfig` (Task 3); `request` (Task 4).
- Produces:
  - `toggle(env): Promise<string>`. Returns `"collapsed"` or `"expanded"`, with `" (unsettled)"` appended when convergence ran out of rounds. Flips the saved flag first, then converges.
  - `refresh(env): Promise<"applied" | "cleared" | "unsettled">`. Always converges. While expanded, that is one source-scoped `agent.view.clear` and no `agent.list`.
  - `env` needs `HERDR_SOCKET_PATH` and `HERDR_PLUGIN_STATE_DIR`; `HERDR_PLUGIN_ID` and `HERDR_PLUGIN_CONFIG_DIR` are optional. Config is re-read on every convergence round; each warning goes to stderr, prefixed `collapse-agents: `, once per process. When either required var is missing, both commands reject with `/HERDR_SOCKET_PATH/`.
  - CLI `node src/cli.mjs <toggle|refresh>`:
    - on success, prints the result on stdout and exits 0;
    - on failure, prints `collapse-agents <command>: <message>` on stderr and exits 1;
    - with an unknown or missing command, prints usage and exits 2.

- [ ] **Step 1: Write the failing tests** in `test/commands.test.mjs`

These tests use barriers, not timing, to force exact interleavings. The fake herdr holds a request until the test releases it. The churn fixtures vary agent *counts*, so that the label, and with it the desired view, actually changes.

```js
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
```

- [ ] **Step 2: Write the failing tests** in `test/cli.test.mjs`

Use the async `execFile`, never `spawnSync`. The fake herdr runs in the test process, and a synchronous spawn would block it from answering.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeHerdr } from "./fake-herdr.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("cli without a command prints usage and exits 2", async () => {
  await assert.rejects(run(process.execPath, [CLI]), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /usage: node src\/cli\.mjs <toggle\|refresh>/);
    return true;
  });
});

test("cli reports failures on stderr and exits 1", async () => {
  await assert.rejects(run(process.execPath, [CLI, "refresh"], { env: {} }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /collapse-agents refresh: .*HERDR_SOCKET_PATH/);
    return true;
  });
});

test("cli toggle collapses through herdr", async (t) => {
  const herdr = await startFakeHerdr((method) =>
    method === "agent.list" ? { type: "agent_list", agents: [] } : { type: "agent_view", active: true },
  );
  const stateDir = await mkdtemp(join(tmpdir(), "ca-cli-"));
  t.after(async () => {
    await herdr.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const env = { HERDR_SOCKET_PATH: herdr.socketPath, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_ID: "collapse-agents" };
  const { stdout } = await run(process.execPath, [CLI, "toggle"], { env });
  assert.equal(stdout.trim(), "collapsed");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `ERR_MODULE_NOT_FOUND` for `src/commands.mjs`, and the 3 CLI tests fail because `src/cli.mjs` is missing.

- [ ] **Step 4: Write `src/commands.mjs`**

```js
import { isDeepStrictEqual } from "node:util";
import { readConfig } from "./config.mjs";
import { buildViewParams } from "./core.mjs";
import { request } from "./herdr-client.mjs";
import { readCollapsed, writeCollapsed } from "./state.mjs";

const MAX_ROUNDS = 20;

function context(env) {
  const socketPath = env.HERDR_SOCKET_PATH;
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!socketPath || !stateDir) {
    throw new Error("HERDR_SOCKET_PATH and HERDR_PLUGIN_STATE_DIR must be set; run this through herdr");
  }
  return {
    socketPath,
    stateDir,
    configDir: env.HERDR_PLUGIN_CONFIG_DIR,
    source: `plugin:${env.HERDR_PLUGIN_ID || "collapse-agents"}`,
    warned: new Set(),
  };
}

// Read on every round, like the flag, so a process that started before a config.json edit
// converges onto the new setting. Each warning reaches the plugin log (stderr) once per process.
async function settings(ctx) {
  const { warnings, ...config } = await readConfig(ctx.configDir);
  for (const warning of warnings) {
    if (ctx.warned.has(warning)) continue;
    ctx.warned.add(warning);
    process.stderr.write(`collapse-agents: ${warning}\n`);
  }
  return config;
}

// The saved flag plus, when collapsed, a view built from a fresh agent.list (never a hook payload).
async function desired(ctx) {
  if (!(await readCollapsed(ctx.stateDir))) return { collapsed: false };
  const config = await settings(ctx);
  const { agents } = await request(ctx.socketPath, "agent.list", {});
  return { collapsed: true, view: buildViewParams(agents, ctx.source, config) };
}

async function apply(ctx, target) {
  if (target.collapsed) await request(ctx.socketPath, "agent.view.set", target.view);
  else await request(ctx.socketPath, "agent.view.clear", { source: ctx.source });
}

// herdr runs one hook process per event, concurrently, so a slow process can overwrite a
// newer view. Each process re-checks after its own write and repeats while anything changed.
// See the spec's "Guarantee" for the races this leaves to the next event.
async function converge(ctx) {
  let target = await desired(ctx);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    await apply(ctx, target);
    const now = await desired(ctx);
    if (isDeepStrictEqual(now, target)) return target.collapsed ? "applied" : "cleared";
    target = now;
  }
  // Out of rounds because agents kept changing. If the user expanded meanwhile, clear now
  // (a clear doesn't depend on agents) and re-check it like any other write.
  if (!target.collapsed) {
    await apply(ctx, target);
    if (!(await readCollapsed(ctx.stateDir))) return "cleared";
  }
  return "unsettled";
}

export async function toggle(env) {
  const ctx = context(env);
  const collapse = !(await readCollapsed(ctx.stateDir));
  await writeCollapsed(ctx.stateDir, collapse); // the flag is the user's intent
  const outcome = await converge(ctx);
  const intent = collapse ? "collapsed" : "expanded";
  return outcome === "unsettled" ? `${intent} (unsettled)` : intent;
}

// Runs in both states, so any event also repairs a view a race left behind.
export async function refresh(env) {
  return converge(context(env));
}
```

- [ ] **Step 5: Write `src/cli.mjs`**

```js
import { refresh, toggle } from "./commands.mjs";

const commands = { toggle, refresh };
const name = process.argv[2];
const command = commands[name];

if (!command) {
  console.error(`usage: node src/cli.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}

try {
  console.log(await command(process.env));
} catch (error) {
  console.error(`collapse-agents ${name}: ${error.message}`);
  process.exit(1);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 53 tests. Run it 5 more times; it must pass every time.

- [ ] **Step 7: Commit**

```bash
git add src/commands.mjs src/cli.mjs test/commands.test.mjs test/cli.test.mjs
git commit -m "feat: add toggle and refresh commands that converge without a lock"
```

---

### Task 6: node launcher

herdr installed as a Homebrew service runs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so a manifest command of `node …` fails to spawn there with `No such file or directory`. The launcher looks for node in this order:
1. the first line of `$HERDR_PLUGIN_CONFIG_DIR/node-path`;
2. `node` on PATH;
3. the newest nvm install, by `sort -V`;
4. `/opt/homebrew/bin/node`, then `/usr/local/bin/node`, then `~/.volta/bin/node`.

**Files:**
- Create: `bin/node-run` (executable)
- Test: `test/node-run.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `sh bin/node-run <args…>` execs the node it finds with `<args…>`. If no node is found, it exits 127 with `collapse-agents: node not found; put its full path in $HERDR_PLUGIN_CONFIG_DIR/node-path` on stderr.

- [ ] **Step 1: Write the failing tests** in `test/node-run.test.mjs`

These tests use fake `node` scripts that echo which copy ran. Two tests skip themselves on machines where a real node sits on the minimal PATH or in a fallback location, because there they can't assert "not found".

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const LAUNCHER = fileURLToPath(new URL("../bin/node-run", import.meta.url));
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"; // what herdr gets as a Homebrew service
const SYSTEM_NODE = ["/usr/bin/node", "/bin/node", "/usr/sbin/node", "/sbin/node"].some(existsSync);
const ANY_FALLBACK_NODE = SYSTEM_NODE || ["/opt/homebrew/bin/node", "/usr/local/bin/node"].some(existsSync);

// A stand-in "node" that reports which copy ran and with what arguments.
async function fakeNode(path, name) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho "${name} $*"\n`);
  await chmod(path, 0o755);
}

async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), "ca-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const launch = (env, ...args) => run("/bin/sh", [LAUNCHER, ...args], { env });

test("uses node from PATH when there is one", async (t) => {
  const home = await sandbox(t);
  await fakeNode(join(home, "bin", "node"), "path-node");
  await fakeNode(join(home, ".nvm/versions/node/v24.1.0/bin/node"), "nvm-node");
  const { stdout } = await launch({ HOME: home, PATH: `${join(home, "bin")}:${MINIMAL_PATH}` }, "src/cli.mjs", "toggle");
  assert.equal(stdout.trim(), "path-node src/cli.mjs toggle");
});

test("falls back to the newest nvm node under a minimal PATH", { skip: SYSTEM_NODE && "node is on the minimal PATH here" }, async (t) => {
  const home = await sandbox(t);
  await fakeNode(join(home, ".nvm/versions/node/v9.11.2/bin/node"), "v9");
  await fakeNode(join(home, ".nvm/versions/node/v24.1.0/bin/node"), "v24");
  await fakeNode(join(home, ".nvm/versions/node/v18.20.0/bin/node"), "v18");
  const { stdout } = await launch({ HOME: home, PATH: MINIMAL_PATH }, "src/cli.mjs", "refresh");
  assert.equal(stdout.trim(), "v24 src/cli.mjs refresh");
});

test("a node-path file in the plugin config dir wins over everything", async (t) => {
  const home = await sandbox(t);
  await fakeNode(join(home, "bin", "node"), "path-node");
  await fakeNode(join(home, "custom", "node"), "custom-node");
  await mkdir(join(home, "config"));
  await writeFile(join(home, "config", "node-path"), `${join(home, "custom", "node")}\n`);
  const env = { HOME: home, PATH: `${join(home, "bin")}:${MINIMAL_PATH}`, HERDR_PLUGIN_CONFIG_DIR: join(home, "config") };
  const { stdout } = await launch(env, "src/cli.mjs", "toggle");
  assert.equal(stdout.trim(), "custom-node src/cli.mjs toggle");
});

test("a missing node is reported with exit 127", { skip: ANY_FALLBACK_NODE && "a fallback node exists here" }, async (t) => {
  const home = await sandbox(t);
  await assert.rejects(launch({ HOME: home, PATH: MINIMAL_PATH }, "src/cli.mjs", "toggle"), (error) => {
    assert.equal(error.code, 127);
    assert.match(error.stderr, /collapse-agents: node not found.*node-path/);
    return true;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. The launcher tests fail because `/bin/sh` can't open `bin/node-run`, and the other 53 pass. That's 4 failures, unless this machine has a real node on the minimal PATH (`/usr/bin`, `/bin`, …) or at `/opt/homebrew/bin` / `/usr/local/bin`. There, 1–2 launcher tests report as skipped instead, and failed + skipped = 4.

- [ ] **Step 3: Write `bin/node-run`** and make it executable (`chmod +x bin/node-run`)

```sh
#!/bin/sh
# Runs node with the given arguments. herdr's server can run with a minimal PATH (as a
# Homebrew service it gets /usr/bin:/bin:/usr/sbin:/sbin), so look for node in the usual places.
# Override: put the full path to node in "$HERDR_PLUGIN_CONFIG_DIR/node-path".

find_node() {
  if [ -n "$HERDR_PLUGIN_CONFIG_DIR" ] && [ -f "$HERDR_PLUGIN_CONFIG_DIR/node-path" ]; then
    head -n 1 "$HERDR_PLUGIN_CONFIG_DIR/node-path"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  newest_nvm=$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -n 1)
  for candidate in "$newest_nvm" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
}

node_bin=$(find_node)
if [ -z "$node_bin" ]; then
  echo "collapse-agents: node not found; put its full path in \$HERDR_PLUGIN_CONFIG_DIR/node-path" >&2
  exit 127
fi
exec "$node_bin" "$@"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 57 tests, with 0 failures. On a machine with a system or fallback node, up to 2 of them count as skipped; passed + skipped = 57.

- [ ] **Step 5: Commit**

```bash
git add bin/node-run test/node-run.test.mjs
git commit -m "feat: add a node launcher for herdr servers with a minimal PATH"
```

---

### Task 7: Manifest, README, and live verification

**Files:**
- Create: `herdr-plugin.toml`
- Create: `README.md`
- Test: `test/manifest.test.mjs`

**Interfaces:**
- Consumes: `sh bin/node-run src/cli.mjs toggle|refresh` (Tasks 5 and 6).
- Produces: a plugin linked into the user's herdr with qualified action `collapse-agents.toggle`.

- [ ] **Step 1: Write the failing test** in `test/manifest.test.mjs`

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL. The 3 manifest tests fail (there is no manifest yet), and the other 57 pass (or pass + skip, as in Task 6).

- [ ] **Step 3: Write `herdr-plugin.toml`**

```toml
id = "collapse-agents"
name = "Collapse Agents"
version = "0.1.0"
min_herdr_version = "0.9.1"
description = "Collapse the sidebar Agents list to a status rollup and the agents waiting on input"
platforms = ["linux", "macos"]

[[actions]]
id = "toggle"
title = "Toggle collapsed Agents list"
contexts = ["global"]
command = ["sh", "bin/node-run", "src/cli.mjs", "toggle"]

# Re-apply the saved collapsed state after a server start.
[[startup]]
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

# Re-apply the view whenever the agent set, a status, "seen" or a pane_id can change.
# Focus events matter because marking an agent seen (done -> idle) emits no status event.
# Moves matter for show = "latest", which filters on a pane_id that a move changes.
[[events]]
on = "pane.agent_status_changed"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "pane.agent_detected"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "pane.closed"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "pane.exited"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "pane.moved"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "pane.focused"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "tab.focused"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "tab.closed"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "tab.moved"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "workspace.focused"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]

[[events]]
on = "workspace.closed"
command = ["sh", "bin/node-run", "src/cli.mjs", "refresh"]
```

- [ ] **Step 4: Write `README.md`**

````markdown
# collapse-agents

A [herdr](https://herdr.dev) plugin that collapses the sidebar **Agents** list.

Collapsed, the list header shows a status rollup in place of `grouped`/`priority`, and the list
shows only agents that are waiting on your input (configurable, see below):

```
 agents   ×1 ✓1 ◐2 ○3
```

`×` blocked (waiting on input) · `✓` done (finished, not yet seen) · `◐` working · `○` idle · `·` unknown.
Statuses with no agents are hidden. When no agent matches, the list body shows herdr's
"no matching agents" line. When the sidebar itself is collapsed, the rail shows only the matching
agents (`1×`, …) and is otherwise empty. Expanding brings back your normal sort mode.

## Install

Requires herdr ≥ 0.9.1 and Node ≥ 18.

```bash
herdr plugin install dptty/herdr-collapse-agents
```

herdr shows what the plugin will run and asks before installing.

Bind the toggle in `~/.config/herdr/config.toml`. The plugin never edits your config.

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "collapse-agents.toggle"
description = "collapse/expand the agents list"
```

Then run `herdr server reload-config`, or restart herdr.

herdr's server often runs with a minimal PATH (for example as a Homebrew service), so the plugin runs
through `bin/node-run`. That launcher also looks in nvm, Homebrew and Volta. If it still can't find
node (the plugin log says `node not found`), tell it where node is:

```bash
command -v node > "$(herdr plugin config-dir collapse-agents)/node-path"
```

## Configuration

Optional. Put a `config.json` in the plugin's config directory:

```bash
echo '{ "statuses": ["blocked", "done"], "show": "all" }' > "$(herdr plugin config-dir collapse-agents)/config.json"
```

| Key | Values | Default |
|---|---|---|
| `statuses` | which statuses the collapsed list shows: any of `"blocked"`, `"done"`, `"working"`, `"idle"`, `"unknown"` | `["blocked"]` |
| `show` | `"all"`: every matching agent. `"latest"`: only the one whose status changed most recently | `"all"` |

Changes take effect at the next agent or focus event, or the next toggle (press it twice to apply
one now). An invalid value falls back to that key's default and logs a warning
(`herdr plugin log list --plugin collapse-agents`). `show_blocked` was renamed to `show`.

`done` means finished and not yet seen *in this herdr client*. Once its pane has been on screen while
your terminal has focus, the agent turns `idle` and leaves the list (unless `statuses` includes
`"idle"`). A client that has just started counts every agent as seen.

## How it works

The plugin uses herdr's `agent.view.set` API. The view's filter follows the settings. With
`show = "all"` it is `status in statuses`, which herdr evaluates live, so agents appear the moment
they match. `"latest"` filters on one agent's pane, which the hooks re-point.
The view's label carries the rollup.
Event hooks re-apply the view when agents change or you change focus, which keeps the counts current.
Each hook re-checks after its write and tries again if anything changed, so concurrent hooks settle
on the latest state without a lock. The collapsed flag is saved in the plugin state directory and
re-applied on startup.

## Limitations

- herdr plugins can't resize the sidebar sections, so collapsing doesn't free rows for spaces.
- It's a toggle, not a third sort mode. While collapsed, clicking the header does nothing.
- The rollup is one colour and isn't visible when the sidebar is collapsed.
- The rows use this client's idea of `done`, but the plugin only sees the server's. So the label's
  `✓`/`○` counts can differ from the rows. With `show = "latest"` and `done` or `idle` in `statuses`,
  the list can occasionally be empty or skip a newer finished agent.
- Collapsing replaces any other plugin's agent view, and holds it while collapsed.
- Two toggles within ~50 ms of each other can count as one.
- If a hook fails (herdr error or timeout) or gives up while agents churn, the view can be stale until the next agent or focus event.
- If you disable the plugin while collapsed, the view returns at the next agent or focus event after re-enabling.

## Development

```bash
git clone https://github.com/dptty/herdr-collapse-agents
cd herdr-collapse-agents
herdr plugin link "$PWD"
npm test
herdr plugin log list --plugin collapse-agents
```

A linked plugin runs your working tree. Re-run `herdr plugin link "$PWD"` after changing
`herdr-plugin.toml`. herdr won't install from GitHub over a linked copy, so run
`herdr plugin unlink collapse-agents` first.

## License

[0BSD](LICENSE)
````

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 60 tests, with 0 failures; passed + skipped = 60.

- [ ] **Step 6: Commit**

```bash
git add herdr-plugin.toml README.md test/manifest.test.mjs
git commit -m "feat: add plugin manifest and README"
```

- [ ] **Step 7: Check the live environment before linking**

Run these steps from a shell inside a herdr pane (`HERDR_ENV=1`). The commands below use `--current` and the pane's herdr context.

Run: `herdr status`
Expected: `server.version` ≥ 0.9.1. The *server* version is what counts, and it can lag the CLI after an upgrade. If it's older, stop and tell the user. Don't restart their server.

Define the helpers the remaining steps use:
- `peek` reports the active agent view without changing it. A clear with a source that doesn't own the view only reports the current one. It finds the socket even when `HERDR_SOCKET_PATH` isn't exported.
- `wait_log` polls the plugin log by id until an entry finishes, for at most 15 s.
- `refresh_now` runs `refresh` exactly as a hook would, using the plugin's own state and config dirs.

```bash
peek() {
  sock="${HERDR_SOCKET_PATH:-$(herdr status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).server.socket??""))')}"
  [ -S "$sock" ] || { echo "no herdr socket at '$sock'" >&2; return 1; }
  node -e '
    const s = require("net").createConnection(process.argv[1]);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", (e) => { console.error(e.message); process.exit(1); });
    s.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) { console.log(buf.slice(0, i)); s.end(); }
    });
    s.write(JSON.stringify({ id: "peek", method: "agent.view.clear", params: { source: "peek:none" } }) + "\n");
  ' "$sock"
}

wait_log() { # usage: wait_log <log_id>
  for _ in $(seq 1 30); do
    entry=$(herdr plugin log list --plugin collapse-agents --limit 200 | ID="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=(JSON.parse(s).result.logs??[]).find(l=>l.log_id===process.env.ID);console.log(e?JSON.stringify(e):"")})')
    case "$entry" in ""|*'"status":"running"'*) sleep 0.5 ;; *) echo "$entry"; return 0 ;; esac
  done
  echo "log entry $1 did not finish within 15s" >&2; return 1
}

refresh_now() { # runs `refresh` the way a hook does, with the plugin's own environment
  HERDR_PLUGIN_ID=collapse-agents \
  HERDR_PLUGIN_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/collapse-agents" \
  HERDR_PLUGIN_CONFIG_DIR="$(herdr plugin config-dir collapse-agents)" \
  HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-$(herdr status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).server.socket))')}" \
  sh bin/node-run src/cli.mjs refresh
}
```

- [ ] **Step 8: Link the plugin and check for manifest warnings**

Run: `herdr plugin link "$PWD" && herdr plugin list --plugin collapse-agents --json`
Expected: `collapse-agents` is enabled, with `warnings: []` and 11 `events`. Re-run `herdr plugin link "$PWD"` whenever `herdr-plugin.toml` changes.

- [ ] **Step 9: Record the starting state, then get to "collapsed"**

Linking keeps any saved state from an earlier install, so don't assume the list starts expanded. The flag lives in the herdr server's state dir, `${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/collapse-agents/state.json`, and a missing file means expanded:

```bash
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/collapse-agents"
initial=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).collapsed===true?"collapsed":"expanded")}catch{console.log("expanded")}' "$STATE_DIR/state.json")
echo "initial: $initial"
```

Then back up the user's plugin settings to a unique temporary file, recording whether they had any, and pin the defaults for the rest of the verification. Step 13 restores the backup.

```bash
CFG="$(herdr plugin config-dir collapse-agents)"
CFG_BACKUP=$(mktemp)
if [ -f "$CFG/config.json" ]; then cp "$CFG/config.json" "$CFG_BACKUP"; HAD_CONFIG=1; else HAD_CONFIG=0; fi
printf '{ "statuses": ["blocked"], "show": "all" }\n' > "$CFG/config.json"
```

**If `initial` is `expanded`:**
- Run `herdr plugin action invoke collapse-agents.toggle` and pass its `result.log.log_id` to `wait_log`. The action runs asynchronously, so don't skip the wait.
- Expected: the entry shows `"status":"succeeded"`, `"exit_code":0` and stdout `collapsed`.
- Diagnosing failures:
  - If its `error` is `No such file or directory`, a spawn failed: check that the manifest uses `sh bin/node-run`.
  - If its stderr says `node not found`, write node's path to `$(herdr plugin config-dir collapse-agents)/node-path` and retry.

**If `initial` is `collapsed`:**
- The view may not be applied yet, because startup hooks don't run on link. Run `refresh_now`.
- Expected: `applied`.

- [ ] **Step 10: Inspect the live view**

Run: `peek`
Expected: `{"id":"peek","result":{"type":"agent_view","active":true,"source":"plugin:collapse-agents","label":"…"}}`. The label's counts must match `herdr agent list`; count each `agent_status`.

- [ ] **Step 11: Show that a blocked agent appears, using a temporary test agent**

Without moving the user's focus, create a pane and make it report itself as a blocked agent:

```bash
pane=$(herdr pane split --current --direction down --cwd "$PWD" --no-focus | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.pane.pane_id))')
herdr pane report-agent "$pane" --source collapse-agents-test --agent needs-input-test --state blocked --message "live test"
```

Expected:
- within a few seconds, `peek` shows a label with one more `×` than before (`×1` if nothing else was blocked);
- `herdr agent list` shows the test agent as `blocked`;
- the user sees it in the collapsed list, alongside any other agents that are already blocked (the defaults are pinned since Step 9).

While the test agent is still blocked, check the settings against live herdr, one at a time. For each one, write it, run `refresh_now`, and check the result before moving on.
- `applied` proves herdr accepted the filter.
- The visible rows are a check for the person at the screen.

```bash
set_config() { printf '%s\n' "$1" > "$CFG/config.json"; refresh_now 2>&1; }
```

- `set_config '{ "show": "latest" }'` prints `applied`. The collapsed list shows exactly one row: the most recently blocked agent.
- `set_config '{ "statuses": ["blocked", "working"] }'` prints `applied`. The list shows every blocked agent and every working one, including the agent running this plan.
- `set_config '{ "statuses": ["blocked", "working"], "show": "latest" }'` prints `applied`. The list shows exactly one row: whichever of those agents changed status most recently.
- `set_config '{ "show": "bogus", "statuses": [] }'` prints two warnings, `collapse-agents: ignoring show "bogus" in config.json; expected one of all, latest` and `collapse-agents: ignoring statuses [] in config.json; expected a non-empty list of blocked, done, working, idle, unknown`, then `applied`. The list behaves as the defaults.
- `set_config '{ "show_blocked": "latest" }'` prints `collapse-agents: ignoring show_blocked in config.json; it was renamed to show` and then `applied`. Every blocked agent is listed.
- `set_config '{ "statuses": ["blocked"], "show": "all" }'` prints `applied`. Every blocked agent is listed again.

Then clean up:

```bash
herdr pane release-agent "$pane" --source collapse-agents-test --agent needs-input-test && herdr pane close "$pane"
```

Expected: `peek` shows the `×` count drop back.

- [ ] **Step 12: Check that the hooks are healthy**

Run: `herdr plugin log list --plugin collapse-agents --limit 200`
Expected: every `sh bin/node-run src/cli.mjs refresh` run has `"status":"succeeded"`, with stdout `applied` (collapsed) or `cleared` (expanded).

- [ ] **Step 13: Restore the user's starting state and hand over**

Restore the user's plugin settings exactly as Step 9 found them, and re-apply:

```bash
if [ "$HAD_CONFIG" = 1 ]; then cp "$CFG_BACKUP" "$CFG/config.json"; else rm -f "$CFG/config.json"; fi
rm -f "$CFG_BACKUP"
refresh_now
```

Expected: `applied`.

- If `initial` was `expanded`, invoke `collapse-agents.toggle` again and `wait_log` its id. Expect stdout `expanded`, and `peek` should show `"active":false`.
- If `initial` was `collapsed`, leave it collapsed.

Tell the user to add the binding from the README to `~/.config/herdr/config.toml` and run `herdr server reload-config`. The startup path isn't exercised live: it's the same `refresh` command the tests cover, and testing it would mean restarting the user's server.
