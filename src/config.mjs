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
