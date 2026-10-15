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
