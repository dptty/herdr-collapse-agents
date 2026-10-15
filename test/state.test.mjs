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
