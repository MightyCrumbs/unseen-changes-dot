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

1. Fork `obsidianmd/obsidian-releases`.
2. Add this object to `community-plugins.json`:

   ```json
   {
     "id": "unseen-changes-dot",
     "name": "Unseen Changes Dot",
     "author": "Miguel Sousa",
     "description": "Shows dots for new or changed notes you have not viewed yet, including folder and tab indicators, without editing note frontmatter.",
     "repo": "MightyCrumbs/unseen-changes-dot"
   }
   ```

3. Open the submission pull request using the draft in `SUBMISSION.md`.
4. Keep the release assets unchanged while the review is open.
5. Address reviewer findings in a new release if they change packaged files.

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
