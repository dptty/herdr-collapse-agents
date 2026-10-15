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
