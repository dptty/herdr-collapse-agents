# collapse-agents: design

A herdr plugin that adds a "collapsed" state to the Agents list in herdr's sidebar. This document describes the plugin as built. The implementation plan (`docs/superpowers/plans/2026-10-14-collapse-agents.md`) reproduces it task by task.

## Problem

The Agents list takes vertical space and shows every agent all the time. The user wants a collapsed state that keeps one signal — by default *does an agent need my input?*, or whichever statuses they pick — and hides everything else, in both the expanded sidebar and the collapsed 4-column rail. They toggle it from the keyboard.

## What herdr allows (constraints that shaped this design)

Verified against the herdr source (`github.com/herdrdev/herdr`, tags v0.9.1 and v0.9.3; the relevant code is identical in both).

- **Plugin v1 has no native UI hooks.** A plugin cannot:
  - add a third `ui.agent_panel_sort` value. The config field is a closed enum, and an unknown value makes herdr fall back to defaults for the *whole* config.
  - add rows or click targets to the sidebar, or draw in the collapsed rail.
  - bind keys. The user adds a `[[keys.command]]` entry instead.
- **The header click is hard-wired in herdr's client** (`src/client/shell/mouse.rs`). It flips `spaces` ↔ `priority`, persists the choice, and emits no event, so a plugin can't observe it or extend it. Upstream discussion herdrdev/herdr#5060 asks for the header toggle to cycle through a plugin's view.
- **Collapsing frees no rows.** The Agents section's height is the sidebar divider split, and no API changes it.
- **`agent.view.set` is the lever.** It is socket-only, with no CLI wrapper. It installs one declarative filter and sort over the built-in Agents list, applied to the expanded sidebar *and* the collapsed rail.
  - While a view is active, the header's right-hand `grouped`/`priority` text is replaced by the view's `label`. The label is 1–32 characters, trimmed, and always drawn in the accent colour.
  - The header click is disabled while a view is active.
  - herdr re-evaluates the filter live whenever agent facts change. The label is a fixed string that only the plugin updates.
  - `agent.view.clear` with the owning `source` restores the user's sort mode.
- **"no matching agents" can't be hidden.** When a view is active and its filtered list is empty, herdr's client draws ` no matching agents` in the list body (`src/client/shell/agent_sidebar.rs`, `render_agent_panel`). A plugin cannot turn that off.
- **Event hooks** run one process per event, concurrently, with no ordering guarantee.
- **The server marks agents seen** (`done → idle` in `agent.list`) for every pane in the active tab, whenever a client reports that its terminal has focus and on explicit focus commands (`src/app/actions.rs`, `mark_active_tab_seen`). This emits no `pane.agent_status_changed` event. Focus events fire when the user switches pane, tab or workspace, but not when the terminal window itself regains focus.
- **The filter language** has `eq`, `in` (1–32 values), `all`, `any`, `not` and `exists` (`src/api/schema/agents.rs`, `AgentViewFilter`).
- **The sidebar's `done` is per client, and independent of the server's.** herdr's client evaluates the filter against its own projection of each agent (`src/client/shell/endpoint_agent_state.rs`, `projected_status`). It only re-projects agents the server reports as `done` or `idle`; `blocked`, `working` and `unknown` pass through unchanged.
  - A server-`done` or server-`idle` agent is `done` in the client until its pane has been on screen while the terminal had focus, and `idle` after.
  - On connecting to a server, a client counts every existing agent as seen, so a freshly started client shows no `done` agents at all.
  - The client never tells the server what it acknowledged. So the client's `done`/`idle` and `agent.list`'s can disagree for as long as neither side changes, not just briefly.

## Behaviour

**Toggle.** The plugin action `collapse-agents.toggle`. The user binds it in `~/.config/herdr/config.toml` (the README documents `prefix+a`). The plugin never edits user config.

**Collapsed.** The plugin sets a view with source `plugin:<HERDR_PLUGIN_ID>` (normally `plugin:collapse-agents`).

- **Label** = a count per status, e.g. `×1 ✓1 ◐2 ○3`. Being in the accent colour, in place of `grouped`/`priority`, is what marks the list as collapsed.
  - Glyphs are always herdr's `symbols` set, whatever `ui.status_indicators` says, because dots are indistinguishable in a one-colour label: blocked `×`, done `✓`, working `◐`, idle `○`, unknown `·`.
  - Order is herdr's native priority: blocked > done > working > idle > unknown.
  - Zero counts are hidden. With no agents at all the label is `0`, because herdr rejects an empty label.
  - Counts above 999 show as `999+`, which keeps the worst case (`×999+ ✓999+ ◐999+ ○999+ ·999+`, 29 chars) inside herdr's 32-char limit.
  - Any status string herdr adds in future counts as unknown.
- **Filter**, chosen by the `statuses` and `show` settings (see **Configuration**). There is never a `sort`, so the user's own `grouped`/`priority` order applies. By default only `blocked` agents are listed: `done` (finished, not yet seen) counts as needing input only if the user adds it.
  - The **status filter** is `{"op":"in","field":"status","values":<statuses>}`, with `statuses` in herdr's priority order. herdr evaluates it live.
  - `show = "all"` (the default): the status filter.
  - `show = "latest"`: the plugin picks the agent with the highest `state_change_seq` among those whose `agent_status` in `agent.list` is one of `statuses`, and sends `{"op":"all","filters":[{"op":"eq","field":"pane_id","value":<pane>}, <status filter>]}`. Ties keep the first agent in `agent.list` order, and a missing seq counts as 0. The list shows at most that one agent.
    - The status filter inside `all` makes the row disappear as soon as that agent leaves the chosen statuses in the client, without waiting for a hook. Without it, a `done` agent that the user has viewed would linger as an `idle` row, because that change fires no status event.
    - With no matching agent in `agent.list` it uses the plain status filter, so a newly matching agent appears before the next hook re-points the filter. Until then the list can show more than one agent.
    - **The pick uses the server's statuses, the rows use the client's.** herdr's filters can't express "the newest matching row", so the pick happens in the plugin, which only sees `agent.list`. When `statuses` includes `done` or `idle`, the two can disagree. The list can then be empty while the client has a matching agent, or skip a newer agent the client shows as `done`. Without `done` and `idle` in `statuses`, both sides report the same statuses and `"latest"` is exact.
- **Result:**
  - When no agent matches, the expanded sidebar shows the header rollup over herdr's ` no matching agents` line, and the collapsed rail shows no agent rows.
  - Each agent the filter keeps appears as its own row (`1×`, `2✓`, `3◐` in the rail).
  - Clicking an agent's row focuses that agent; that is native herdr behaviour. Viewing a `done` agent this way turns it `idle`, so it leaves the list unless `statuses` includes `idle`.

**Configuration.** This is optional. The settings file is `$HERDR_PLUGIN_CONFIG_DIR/config.json`, i.e. `$(herdr plugin config-dir collapse-agents)/config.json`, holding a JSON object, e.g. `{ "statuses": ["blocked", "done"], "show": "all" }`.

| Key | Values | Default |
|---|---|---|
| `statuses` | a non-empty list of `blocked`, `done`, `working`, `idle`, `unknown`. Duplicates are ignored and order doesn't matter. | `["blocked"]` |
| `show` | `"all"` or `"latest"` | `"all"` |

- herdr creates the directory but never reads the file; the plugin owns the format.
- Each process re-reads the file on every convergence round, like the flag, so a process that started before an edit converges onto it. Each warning is written once per process.
- An edit doesn't start a hook by itself, so it takes effect at the next event or toggle.
- A missing file means the defaults.
- If the file can't be read (any error other than "missing") or isn't a JSON object, the plugin uses the defaults and writes `collapse-agents: <warning>` to stderr, which herdr keeps in the plugin log.
- An invalid `statuses` (not a list, empty, or naming anything else) or `show` falls back to that key's default, with a warning. The two keys are checked independently.
- `show_blocked`, the old name of `show`, is ignored with a warning saying it was renamed.

**Expanded.** The plugin clears its view, scoped to its source so another owner's view is left alone. The user's `grouped`/`priority` mode returns unchanged.

**Persistence.** The collapsed flag lives in `$HERDR_PLUGIN_STATE_DIR/state.json` as `{"collapsed": true|false}` and survives restarts. A `[[startup]]` hook re-applies the view on server start.

**Updates.** Event hooks run `refresh` on these events:
- `pane.agent_status_changed`, `pane.agent_detected`
- `pane.closed`, `pane.exited`, `tab.closed`, `workspace.closed`
- `pane.moved`, `tab.moved`. These are needed because a moved pane gets a new `pane_id`, which `show = "latest"` filters on.
- `pane.focused`, `tab.focused`, `workspace.focused`. These are needed because the server marks agents seen without a status event (see **What herdr allows**). Its seen flag decides the label's `✓`/`○` counts and `"latest"`'s pick.

With `show = "all"`, which agents are listed is always live, because herdr evaluates the filter itself. With `"latest"`, the hooks re-point the filter. In every mode, the hooks keep the label's counts current. Every `refresh` converges, in both states. While expanded, that costs one source-scoped `agent.view.clear` and no `agent.list`. As a result, any event repairs a view a race left in the wrong state, in either direction.

**Convergence (no lock).** Hook processes run concurrently, so a slow process can overwrite a newer view. Instead of a lock, every process verifies its own write:

1. Compute the desired state: the saved flag plus, when collapsed, view params built from the current settings and a fresh `agent.list`. Never use the hook's event payload.
2. Apply it: `agent.view.set`, or a source-scoped `agent.view.clear` when expanded.
3. Compute the desired state again. If it's unchanged, stop. Otherwise apply the new one and repeat, up to 20 rounds.
4. Running out of rounds takes agents changing on every round, 20 in a row.
   - If the latest desired state at that point is expanded, apply the clear (a clear doesn't depend on agents) and re-check the flag, as for any write. Report `cleared` only if the flag still says expanded.
   - Otherwise, including running out of rounds while collapsed, report `unsettled`.

Two consequences:
- An expand that lands mid-refresh is undone by the refresh's re-check, which sees the flag is now expanded and clears the view.
- An older process whose write lands after a newer one has finished sees the newer state in its re-check and writes again.

**Guarantee.** Take the processes (hooks and toggles) started by a burst of state changes. If every one of them reports `applied` or `cleared`, the view herdr holds matches the one computed from the saved flag, the settings and `agent.list` once the last one finishes. Which rows the client then shows is herdr's evaluation of that view, against the client's own statuses (see **What herdr allows**). The guarantee holds because:
- each successful process writes at least once;
- after its last write, it verifies that the state still matches;
- any change after that verification starts another process, which writes later. Two changes start no process. A `config.json` edit is picked up by in-flight processes in their next round. A server seen-marking without a focus event changes `agent.list`'s `done`/`idle`.

The view can be stale only in four cases:
- a process in the burst failed (herdr error or timeout, before or after writing);
- a process reported `unsettled`;
- `config.json` was edited after the burst's last process finished. An edit starts no hook.
- the server marked agents seen without a focus event, e.g. when the terminal window itself regained focus. That leaves the label's `✓`/`○` counts, and a `"latest"` pick that involves `done` or `idle`, stale.

In each case, the view stays stale until the next event of any kind, whose refresh converges again. Closing the first two without a further event would need a lock or a compare-and-set on herdr's view, and neither exists. The last two start no process at all, so only polling or a new trigger could close them.

**Toggle semantics.** `toggle` flips the saved flag first, because the flag is the user's intent, and then converges. It reports `collapsed` or `expanded`, with ` (unsettled)` appended when convergence ran out of rounds. If herdr fails, the flag stays flipped and the error goes to the plugin log. The next event or toggle converges again.

**No extra escalation.** The red `×` row and the `×n` count are the "an agent needs you" signal.

## Environment requirements (found while installing on a real machine)

- **herdr ≥ 0.9.1** (`min_herdr_version = "0.9.1"`). The `herdr` CLI and the running server can be different versions after an upgrade. The server is what matters: run `herdr status`. In our case the CLI was 0.9.3 and the server 0.9.1, and the server rejected a 0.9.3 minimum. Never restart the user's server to fix this, because it hosts their running agents.
- **node ≥ 18, found by `bin/node-run`.** herdr installed as a Homebrew service runs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `node` command fails to spawn (`No such file or directory`). Every manifest command therefore runs `sh bin/node-run src/cli.mjs …`. The launcher tries, in order:
  1. the first line of `$HERDR_PLUGIN_CONFIG_DIR/node-path`;
  2. `node` on PATH;
  3. the newest `~/.nvm/versions/node/v*/bin/node`, by `sort -V`;
  4. `/opt/homebrew/bin/node`, then `/usr/local/bin/node`, then `~/.volta/bin/node`.

  If none exists, it exits 127 with a message naming the override file.
- **herdr accepts a `plugin:<id>` view source only while that plugin is linked and enabled.**
- **`herdr plugin link <path>` re-reads the manifest.** Re-run it after changing `herdr-plugin.toml`.
- **`herdr plugin action invoke` is asynchronous.** It returns a `log_id`. Poll `herdr plugin log list --plugin <id>` for that id before inspecting results.

## Decision log

- **Plugin, not a fork.** The user wanted a plugin, accepting that no rows are reclaimed and the header can't be clicked.
- **Keyboard toggle only.** The user considered and declined a "fake agent pane as a clickable button" hack: it costs a real pane, focus flicker, and a misleading agent count.
- **Blocked-only filter.** This replaced an earlier "single most urgent agent" row. The user found a permanently visible agent distracting: "only when they require my input should agents be visible".
- **`show` setting.** The user asked to choose between showing all blocked agents or only the latest one. It lives in the plugin config dir because herdr has no managed plugin settings. It was first called `show_blocked`, and was renamed when `statuses` made it apply to more than blocked agents. The plugin had one user and no released versions, so the old name gets a warning, not an alias.
- **`statuses` setting.** The user wanted finished agents in the collapsed list too, and then to pick which statuses are included. Any non-empty subset of herdr's five statuses is allowed. An empty list is refused because it would only ever show ` no matching agents`, the reason `"none"` was dropped.
- **`"latest"` picks from the server's statuses.** A design review showed the pick can't follow the client's `done`/`idle`, because herdr's filters can't express "the newest matching row" and the client's seen state isn't readable. This was accepted and documented rather than worked around, because the user runs `show = "all"`, which herdr evaluates entirely in the client.
- **No `"none"` option.** A third value, which showed no agent rows at all, was built and then dropped. It always left herdr's ` no matching agents` line visible, which the user disliked. The user also declined dimming that line globally, through the theme's `overlay0` or Ghostty's `faint-opacity`, because both dim other text too.
- **No `▸` marker.** The label used to start with `▸`. The user found it unnecessary, because the accent-coloured rollup in place of `grouped`/`priority` already shows that the list is collapsed.
- **No lock.** A directory lock with stale-lock recovery had races in which a process deleted another's lock, so it was replaced by verified convergence.
- **A launcher instead of editing the herdr service's PATH.** Editing it would touch the user's system and require a server restart.

## Accepted limitations

- No vertical space is reclaimed.
- Not a third sort mode. The header click is disabled while collapsed.
- herdr shows ` no matching agents` while collapsed and no agent matches, and a plugin cannot suppress or restyle it. It is drawn in the theme's shared `overlay0` grey with the terminal's faint attribute, so it can only be dimmed together with other text.
- The rollup is one accent colour and isn't visible in the collapsed rail.
- The rows follow this client's seen state, while the label's `✓`/`○` counts and `"latest"`'s pick follow the server's (see **What herdr allows**). The two can disagree for as long as neither side changes. For example, a freshly started client lists no `done` rows while the label still counts `✓`. No refresh can reconcile them, because the plugin cannot read the client's state. With `show = "latest"` and `done` or `idle` in `statuses`, this can leave the list empty or skip a newer finished agent.
- Collapsing replaces any other active view, and while collapsed every refresh re-asserts this plugin's view.
- If the plugin is disabled while collapsed, herdr drops the view. On re-enable it comes back at the next event, not immediately, because startup hooks don't run on enable.
- Two toggles whose processes overlap (within ~50 ms) can both read the same flag and count as one.
- In the rare races described under **Guarantee**, the view can be stale until the next agent or focus event.
- Single machine assumed. The label counts the local server's `agent.list`.
- macOS and Linux only.

## Implementation shape

Node ESM, no dependencies, no build step, at the repo root. Users install it with `herdr plugin install dptty/herdr-collapse-agents`; development links a clone with `herdr plugin link`.

| File | Responsibility |
|---|---|
| `herdr-plugin.toml` | Manifest: action, startup hook, 11 event hooks, all run through `bin/node-run` |
| `bin/node-run` | POSIX sh launcher that finds node under a minimal PATH |
| `src/core.mjs` | Pure: status rollup label, the status and `"latest"` filters, view params |
| `src/config.mjs` | Reads and validates `config.json` from the plugin config dir |
| `src/state.mjs` | Collapsed flag file (atomic writes) |
| `src/herdr-client.mjs` | One-shot newline-JSON request over herdr's Unix socket, with an absolute deadline |
| `src/commands.mjs` | `toggle` and `refresh`, both built on convergence |
| `src/cli.mjs` | argv entrypoint used by the manifest |
| `test/fake-herdr.mjs` | In-process fake herdr socket server |

There are 60 tests, all using `node:test`:
- core, state, config and the socket client are unit-tested;
- the commands are tested against the fake socket server, with barrier tests that force each race ordering;
- the launcher is tested with fake node binaries under a minimal PATH;
- the manifest is tested as text.

The live plugin is verified against a running herdr, including a temporary pane that reports itself as a blocked agent.
