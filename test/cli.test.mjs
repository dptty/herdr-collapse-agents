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
