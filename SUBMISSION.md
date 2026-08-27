# Obsidian Community directory submission record

Use this record only after the repository is public, release `1.0.31` exists,
and the derivative-work gate below is resolved.

## Directory metadata

- Name: Unseen Changes Dot
- ID: `unseen-changes-dot`
- Author: Miguel Sousa
- Repository: `MightyCrumbs/unseen-changes-dot`
- Description: Shows dots for new or changed notes you have not viewed yet,
  including folder and tab indicators, without editing note frontmatter.
- Initial public version: `1.0.29`
- Current public version: `1.0.31`
- Minimum Obsidian version: `1.4.4`
- Desktop only: no

The Community directory reads this metadata from `manifest.json` at the HEAD
of the repository's default branch. Initial submission is made through
`https://community.obsidian.md`, after linking the owning GitHub account.

## What it does

The plugin marks new notes and changed notes with separate dots in the file
explorer, parent folders, and background tabs. Opening the active note marks
its current version as seen. It does not write state to note frontmatter.

## Data and network use

The plugin makes no network requests and contains no telemetry. It stores file
paths, signatures, timestamps, and seen state through Obsidian's plugin data
API inside the vault configuration directory. It does not store note content
in its tracking files. At startup it lists Markdown paths, plus attachment
paths only when attachment tracking is enabled, to detect offline changes.

## Validation evidence

- Automated tests, syntax checks, release metadata checks, and release asset
  hashes for version 1.0.31 pass on Icarus Omarchy Linux.
- Obsidian 1.13.7 passed the isolated-vault marker flows for version 1.0.29 on
  Icarus Omarchy Linux and the Windows VM hosted by Icarus Omarchy.
- Native marker and storage migration checks specific to version 1.0.31 remain
  outstanding. The Windows VM hosted by Icarus Omarchy was unavailable during
  release preparation; Athena and the physical Icarus Windows host were not
  used.
- The plugin was statically checked for Node.js and Electron-only APIs because
  `isDesktopOnly` is `false`.
- The original MIT attribution for Unread Dot is preserved.

## Derivative-work gate

The repository credits Unread Dot for inherited structure and its
file-explorer marker approach. Obsidian's current developer policy does not
admit forks or inherited implementations without publicly verifiable written
approval from the original author, except through its documented abandoned
project process. Preserve a link to that approval before submitting. If the
project instead becomes an independently reviewed clean implementation, record
that review and update the attribution accurately.

## Final pre-submission checklist

- [ ] Publicly verifiable approval from the Unread Dot author is recorded, or
      an independent clean-implementation review closes the derivative gate.
- [x] Repository visibility is public.
- [ ] `manifest.json` is accurate on the default branch.
- [ ] Release `1.0.31` exists and its tag exactly matches `manifest.json`.
- [ ] The release has `main.js`, `manifest.json`, and `styles.css` as separate
      assets.
- [ ] Downloaded release assets match the locally recorded checksums.
- [x] Desktop testing passes in isolated Linux and Windows VM vaults.
- [x] `unseen-changes-dot` was absent from the official directory on
      2026-08-27.
- [x] The owning Obsidian account is linked to the matching GitHub account.
- [x] Publication has explicit approval.
