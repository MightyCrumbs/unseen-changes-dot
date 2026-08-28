# Unseen Changes Dot

Unseen Changes Dot shows which notes are new and which existing notes changed
since you last viewed them. It adds small markers to the Obsidian file explorer,
parent folders, and background tabs without modifying note frontmatter.

![Illustration of new and changed note markers](docs/unseen-changes-dot-preview.svg)

Current packaged version: `1.0.31`.

## What the markers mean

| Marker | Meaning | Default colour |
| --- | --- | --- |
| New | The file was created and has not been viewed yet. | Light blue |
| Changed | A previously viewed file changed while it was not active. | Obsidian accent colour |

Opening a note in the active tab marks its current version as seen. A new file
keeps the stronger `new` state if it changes before you open it.

Folders inherit markers from unseen descendants. A folder can show both states
when it contains both new and changed files.

## Features

- Tracks Markdown files by default.
- Can track attachments when enabled.
- Shows markers in the file explorer and on background tabs.
- Lets you choose which states to show.
- Supports circle, rounded, square, and diamond marker shapes.
- Accepts CSS colours, including Obsidian theme variables.
- Keeps tracking data out of note frontmatter.
- Ignores plugin runtime files and task notes marked with `task` or `tasks`.
- Prunes state for missing files and stale seen-pulse entries.

## Storage and sync

The main state file is:

```text
<vault-config-dir>/plugins/unseen-changes-dot/data.json
```

Per-file seen pulses are stored in:

```text
<vault-config-dir>/plugins/unseen-changes-dot/seen-pulses/
```

If your sync service includes the vault configuration directory, `data.json`
and `seen-pulses/` can sync between devices. The plugin reconciles synced state
against current file signatures.

Do not include runtime state in a release package:

```text
data.json
seen-pulses/
.DS_Store
```

## Settings

- `Shown states`: show new, changed, or both.
- `Track attachments`: off by default.
- `Sync polling interval`: defaults to 5 seconds.
- `Fast startup baseline`: on by default.
- `Unread/new shape` and `Changed shape`: choose the marker shape.
- `Unread/new color` and `Changed color`: set any valid CSS colour.

## Credits and licence

Miguel Sousa maintains Unseen Changes Dot. The initial structure and
file-explorer marker approach were based on Dennis Mojado's
[Unread Dot](https://github.com/denmojo/obsidian-unread-dot).

The project is available under the [MIT License](LICENSE). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution details.
