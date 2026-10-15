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
