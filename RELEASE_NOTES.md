# Unseen Changes Dot 1.0.31

This release completes the automated Community directory build checks.

## Included

- Adds the deterministic `npm run build` command expected by the Community
  directory. The command validates the committed `main.js`, which is both the
  source and distributable artefact.
- Keeps the storage, startup inventory, lockfile, and attested release changes
  from version 1.0.30.

## Compatibility

- Requires Obsidian 1.4.4 or newer.
- Do not enable Unread Dot and Unseen Changes Dot at the same time because both
  plugins add file-explorer markers.

See the README for storage, privacy, installation, and troubleshooting details.
