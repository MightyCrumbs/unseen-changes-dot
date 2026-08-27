# Release procedure

This repository does not publish automatically. Every public action is manual.
Do not run the GitHub commands below until the maintainer approves publication.

## 1. Finish the release candidate

1. Update the version in `manifest.json`, `package.json`, `main.js`, and
   `versions.json`.
2. Move the matching changelog section from `Unreleased` to the release date.
3. Run the local checks:

   ```sh
   npm run release:prepare
   ```

4. Inspect these generated files:

   ```text
   release/unseen-changes-dot-<version>/main.js
   release/unseen-changes-dot-<version>/manifest.json
   release/unseen-changes-dot-<version>/styles.css
   release/unseen-changes-dot-<version>/SHA256SUMS
   ```

5. Install the three plugin files in an isolated vault and test the new and
   changed markers. Test mobile before keeping `isDesktopOnly` set to `false`.

## 2. Make the source public

These are external actions. Run them only after approval.

1. Commit and push the accepted release candidate.
2. Change `MightyCrumbs/unseen-changes-dot` from private to public.
3. Confirm that the public repository exposes the README, licence, source, and
   third-party notice.

Before submitting to the Obsidian Community directory, resolve the derivative
work gate. This project credits Unread Dot for inherited structure and the
file-explorer marker approach. Obsidian's current developer policy requires
publicly verifiable written approval from the original author for a fork or
other inherited implementation. Do not submit until that evidence exists, or
until an independently reviewed clean implementation no longer inherits code
from the original project.

## 3. Create the GitHub release

The Git tag must match the `version` in `manifest.json` exactly. Do not add a
`v` prefix.

For version `1.0.29`:

```sh
git tag 1.0.29
git push origin 1.0.29
gh release create 1.0.29 \
  release/unseen-changes-dot-1.0.29/main.js \
  release/unseen-changes-dot-1.0.29/manifest.json \
  release/unseen-changes-dot-1.0.29/styles.css \
  --repo MightyCrumbs/unseen-changes-dot \
  --title "1.0.29" \
  --notes-file RELEASE_NOTES.md
```

Download the three assets from the release page and compare their SHA-256
checksums with the local `SHA256SUMS` file.

## 4. Submit to the Obsidian community directory

1. Sign in at `https://community.obsidian.md` with the Obsidian account that
   will own the listing.
2. Link the matching GitHub account to the community profile.
3. Add the plugin through the Community directory. The directory reads
   `manifest.json` from the HEAD of the repository's default branch.
4. Confirm that the plugin ID is still unique, the repository is public, and
   the GitHub release whose tag matches `manifest.json` contains `main.js`,
   `manifest.json`, and `styles.css` as separate assets.
5. Keep the release assets unchanged while automated review is running.
6. Address findings in a new release with an incremented version whenever a
   packaged file changes.

Obsidian reads the latest version from `manifest.json` and downloads the files
from the GitHub release with the identical tag.

## 5. Publish later updates

For each accepted update:

1. Increment the version everywhere.
2. Add the new version to `versions.json`.
3. Update the changelog and release notes.
4. Run `npm run release:prepare` and repeat the isolated-vault checks.
5. Commit, tag, push, and create the matching GitHub release.

The initial directory submission is not repeated for normal updates.
