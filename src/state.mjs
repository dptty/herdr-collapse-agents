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
