'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'unseen-changes-dot-vault-'));
const obsidianPath = path.join(vaultPath, '.obsidian');
const pluginPath = path.join(obsidianPath, 'plugins', 'unseen-changes-dot');

fs.mkdirSync(pluginPath, { recursive: true });

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  fs.copyFileSync(path.join(repositoryRoot, file), path.join(pluginPath, file));
}

fs.writeFileSync(
  path.join(obsidianPath, 'community-plugins.json'),
  JSON.stringify(['unseen-changes-dot'], null, 2) + '\n'
);

fs.writeFileSync(
  path.join(vaultPath, 'Welcome.md'),
  '# Welcome\n\nEdit this note to exercise the changed-state dot.\n'
);

fs.writeFileSync(
  path.join(vaultPath, 'Ignored task.md'),
  '---\ntags:\n  - task\n---\n\nThis note should not receive an unseen dot.\n'
);

fs.writeFileSync(
  path.join(vaultPath, 'Test plan.md'),
  [
    '# Test plan',
    '',
    '1. Enable Unseen Changes Dot if Obsidian asks for confirmation.',
    '2. Open Welcome, run "Mark current file as unseen", then switch to this note.',
    '3. Confirm that Welcome gains a changed dot and that reopening it clears the dot.',
    '4. Confirm that Ignored task never gains a dot.',
    '5. Change both shapes and colors in the plugin settings and inspect file, folder, and tab dots.',
    ''
  ].join('\n')
);

console.log(vaultPath);
