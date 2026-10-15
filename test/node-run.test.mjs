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
