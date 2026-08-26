# Unseen Changes Dot

Personal Obsidian dot plugin for Miguel's vault.

Current packaged version: `1.0.28`.

Version numbering was rebased so legacy build `42` is treated as release `1`.

This is rebuilt from Reysu's `unread-dot` plugin structure, but it remains a separate plugin.

## Behavior

- Does not use note frontmatter to store read/unread state.
- Shows dots for files that are `new` or `changed` and have not been viewed on this device.
- Uses a light blue dot for `new` files and the theme accent color for `changed` files.
- Keeps `new` as the stronger state when a new file changes before being viewed.
- Shows folder dots when child files are unseen.
- Shows both folder states side by side when a folder contains both `new` and `changed` files.
- Shows dots in background tabs.
- Defaults to markdown-only tracking so large vaults stay lighter.
- Uses a fast metadata baseline for startup, pulse imports, and already-seen files.
- Reuses the last known state on launch and defers heavier hydration work until after Obsidian is already open.
- Delays attachment tracking until after the initial startup pass, so `Track attachments` no longer slows the first app open nearly as much.
- Prunes missing files and orphan seen-pulse entries so old runtime state does not keep bloating the plugin over time.
- Avoids duplicate seen-pulse writes, prunes stale pulse files, and ignores its own explorer-dot DOM mutations to keep the UI more responsive.
- Keeps explorer and tab dots visually centered more consistently across refreshes and folder open/close states.
- Stores sync state through the standard plugin data path and keeps pulse files inside the vault config directory, which is safer for custom config folders and mobile.
- Marks only the active/front tab as seen.
- Ignores plugin runtime files.
- Ignores task notes tagged or marked as `task`, `tasks`, `#task`, or `#tasks`.

## Storage

Runtime state is kept only inside:

```text
<vault-config-dir>/plugins/unseen-changes-dot/
```

Main sync state:

```text
<vault-config-dir>/plugins/unseen-changes-dot/data.json
```

Per-file seen pulses:

```text
<vault-config-dir>/plugins/unseen-changes-dot/seen-pulses/<hash>.json
```

The plugin also keeps a device-local `localStorage` cache for seen signatures and startup state.

Do not copy or package runtime state:

```text
data.json
seen-pulses/
.DS_Store
```

## Sync Notes

- Markdown signatures use content hashing: `md:<size>:<hash>`.
- Fast mode can also use metadata signatures: `mdm:<size>:<mtime>`.
- Attachments use file metadata: `<extension>:<size>:<mtime>`.
- When a file is marked seen, the plugin writes both the main state and a per-file seen pulse.
- If stale synced state tries to reintroduce a dot for a file version already seen locally, the plugin reconciles it back to `seen` when the current signature matches the stored seen signature.

## Settings

- `Shown states`: show unread/new, changed, or both.
- `Track attachments`: off by default for better performance.
- `Sync polling interval`: defaults to `5s`.
- `Fast startup baseline`: on by default.
- `Unread/new shape` and `Changed shape`: `circle`, `rounded`, `square`, or `diamond`.
- `Unread/new color` and `Changed color`: any CSS color value, including theme variables such as `var(--interactive-accent)`.

## Commands

- `Unseen Changes Dot: Show unseen changes status`
- `Unseen Changes Dot: Reset unseen state baseline`
- `Unseen Changes Dot: Show storage debug`
- `Unseen Changes Dot: Mark current file as seen`
- `Unseen Changes Dot: Mark current file as unseen`

## Install

Copy the plugin files to the active Obsidian vault:

```text
<vault-config-dir>/plugins/unseen-changes-dot/
```

Then reload Obsidian and enable `Unseen Changes Dot`.

Do not enable Reysu's `Unread Dot` and this plugin at the same time, or you may see duplicate dots.

If anything looks wrong, run `Unseen Changes Dot: Reset unseen state baseline`.

## Development

The repository ships `main.js` directly. There is no compilation step and no
runtime dependency installation.

Run the local checks with Node.js 20 or newer:

```sh
npm test
npm run check
```

Prepare a temporary isolated vault with the current plugin files:

```sh
npm run vault:prepare
```

The command creates the vault under the operating system's temporary directory.
Open that generated directory as an Obsidian vault. It does not read or modify
any existing vault.
