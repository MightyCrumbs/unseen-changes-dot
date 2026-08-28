# Unseen Changes Dot documentation

## Privacy and network access

The plugin does not send data over the network and does not use analytics or
telemetry. At startup it lists Markdown files to detect changes made while the
plugin was not running. If attachment tracking is enabled, that startup list
also includes non-Markdown files. The plugin reads Markdown content when it
needs to calculate a signature.

All persisted state uses Obsidian's plugin data API and stays in the vault
configuration directory.

No note content is written to the tracking files. The stored values contain
paths, timestamps, sizes, signatures, and state used by the plugin.

## Commands

- `Unseen Changes Dot: Show unseen changes status`
- `Unseen Changes Dot: Reset unseen state baseline`
- `Unseen Changes Dot: Show storage debug`
- `Unseen Changes Dot: Mark current file as seen`
- `Unseen Changes Dot: Mark current file as unseen`

## Installation

### Obsidian community plugins

1. Open `Settings` in Obsidian.
2. Select `Community plugins`, then `Browse`.
3. Search for `Unseen Changes Dot`.
4. Select `Install`, then `Enable`.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the matching
   GitHub release.
2. Create this folder inside the vault configuration directory:

   ```text
   plugins/unseen-changes-dot/
   ```

3. Copy the three files into that folder.
4. Reload Obsidian and enable `Unseen Changes Dot` under `Community plugins`.

Do not enable [Unread Dot](https://github.com/denmojo/obsidian-unread-dot) and
Unseen Changes Dot at the same time. Both plugins add markers to the file
explorer, so enabling both can produce duplicate dots.

If the displayed state looks wrong, run
`Unseen Changes Dot: Reset unseen state baseline` from the command palette.

## Compatibility and limitations

- The minimum supported Obsidian version is `1.4.4`.
- The plugin is designed to avoid Node.js and Electron-only APIs.
- File-explorer markers depend on Obsidian's rendered explorer structure. A
  future Obsidian update may require selector adjustments.
- Attachment signatures use file size and modification time. Markdown files
  use content or metadata signatures, depending on startup mode.

## Development

The repository ships `main.js` directly. It has no runtime dependencies or
compilation step. The build command checks the committed artefact's syntax:

```sh
npm run build
```

Run the checks with Node.js 20 or newer:

```sh
npm run check
```

Prepare an isolated test vault:

```sh
npm run vault:prepare
```

Validate and prepare the release files locally:

```sh
npm run release:prepare
```

The release process is documented in [RELEASING.md](RELEASING.md).
