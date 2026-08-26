# Obsidian community plugin submission draft

Use this text only after the repository is public and release `1.0.29` exists.

## Pull request title

```text
Add Unseen Changes Dot plugin
```

## Registry entry

```json
{
  "id": "unseen-changes-dot",
  "name": "Unseen Changes Dot",
  "author": "Miguel Sousa",
  "description": "Shows dots for new or changed notes you have not viewed yet, including folder and tab indicators, without editing note frontmatter.",
  "repo": "MightyCrumbs/unseen-changes-dot"
}
```

## Pull request body

```text
## Plugin information

- Name: Unseen Changes Dot
- ID: unseen-changes-dot
- Repository: https://github.com/MightyCrumbs/unseen-changes-dot
- Initial public version: 1.0.29
- Minimum Obsidian version: 1.4.4
- Desktop only: no

## What it does

The plugin marks new notes and changed notes with separate dots in the file
explorer, parent folders, and background tabs. Opening the active note marks
its current version as seen. It does not write state to note frontmatter.

## Data and network use

The plugin makes no network requests and contains no telemetry. It stores file
paths, signatures, timestamps, and seen state inside the vault configuration
directory and Obsidian local storage. It does not store note content in its
tracking files.

## Validation

- Automated tests pass.
- Release metadata and assets pass the local release validator.
- New-file and changed-file dots were checked visually in Obsidian.
- The original MIT attribution for Unread Dot is preserved.
```

## Final pre-submission checklist

- [ ] Repository visibility is public.
- [ ] Release `1.0.29` exists.
- [ ] Release tag matches `manifest.json` exactly.
- [ ] The release has `main.js`, `manifest.json`, and `styles.css` as separate assets.
- [ ] The three downloaded release assets match the local checksums.
- [ ] Desktop testing passes in an isolated vault.
- [ ] Mobile testing passes while `isDesktopOnly` is `false`.
- [ ] The community registry does not already contain `unseen-changes-dot`.
- [ ] Publication has explicit approval.
