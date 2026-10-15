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
