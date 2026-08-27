# Unseen Changes Dot 1.0.30

This release addresses the first automated Community directory review.

## Included

- Persisted state now uses Obsidian's plugin data API without browser local
  storage.
- The default startup inventory is limited to Markdown files. Attachment paths
  are included only when attachment tracking is enabled.
- GitHub Actions generates provenance attestations for the packaged release
  assets.

## Compatibility

- Requires Obsidian 1.4.4 or newer.
- Do not enable Unread Dot and Unseen Changes Dot at the same time because both
  plugins add file-explorer markers.

See the README for storage, privacy, installation, and troubleshooting details.
