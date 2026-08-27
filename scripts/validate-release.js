'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(root, fileName), 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = readJson('manifest.json');
const packageJson = readJson('package.json');
const versions = readJson('versions.json');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const releaseNotes = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8');
const releasing = fs.readFileSync(path.join(root, 'RELEASING.md'), 'utf8');
const submission = fs.readFileSync(path.join(root, 'SUBMISSION.md'), 'utf8');

const requiredFiles = [
  'main.js',
  'manifest.json',
  'styles.css',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'RELEASE_NOTES.md',
  'RELEASING.md',
  'SUBMISSION.md'
];

for (const fileName of requiredFiles) {
  const filePath = path.join(root, fileName);
  assert(fs.existsSync(filePath), `Missing required file: ${fileName}`);
  assert(fs.statSync(filePath).size > 0, `Required file is empty: ${fileName}`);
}

assert(manifest.id === 'unseen-changes-dot', 'Unexpected plugin id');
assert(manifest.name === 'Unseen Changes Dot', 'Unexpected plugin name');
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Manifest version must use x.y.z');
assert(packageJson.version === manifest.version, 'package.json version does not match manifest.json');
assert(versions[manifest.version] === manifest.minAppVersion, 'versions.json does not map the current version to minAppVersion');
assert(manifest.author === 'Miguel Sousa', 'Public manifest author must be Miguel Sousa');
assert(manifest.authorUrl === 'https://github.com/MightyCrumbs', 'Unexpected authorUrl');
assert(typeof manifest.description === 'string' && manifest.description.length > 0, 'Manifest description is required');
assert(manifest.description.length <= 250, 'Manifest description exceeds 250 characters');
assert(manifest.description.endsWith('.'), 'Manifest description must end with a period');
assert(/^[a-z-]+$/.test(manifest.id), 'Plugin id may contain only lowercase letters and hyphens');
assert(!manifest.id.includes('obsidian'), 'Plugin id must not contain obsidian');
assert(!manifest.id.endsWith('plugin'), 'Plugin id must not end with plugin');
assert(typeof manifest.isDesktopOnly === 'boolean', 'isDesktopOnly must be a boolean');
assert(
  mainSource.includes(`const PLUGIN_VERSION = '${manifest.version}';`),
  'main.js PLUGIN_VERSION does not match manifest.json'
);
assert(readme.includes(`Current packaged version: \`${manifest.version}\`.`), 'README packaged version does not match manifest.json');
assert(readme.includes('THIRD_PARTY_NOTICES.md'), 'README must link to third-party notices');
assert(releaseNotes.startsWith(`# Unseen Changes Dot ${manifest.version}\n`), 'Release notes version does not match manifest.json');
assert(fs.existsSync(path.join(root, 'docs', 'unseen-changes-dot-preview.svg')), 'README preview image is missing');

const expectedSubmissionFields = [
  `- Name: ${manifest.name}`,
  `- ID: \`${manifest.id}\``,
  `- Author: ${manifest.author}`,
  '- Repository: `MightyCrumbs/unseen-changes-dot`',
  `- Initial public version: \`${manifest.version}\``,
  `- Minimum Obsidian version: \`${manifest.minAppVersion}\``
];

for (const expectedField of expectedSubmissionFields) {
  assert(submission.includes(expectedField), `SUBMISSION.md is missing directory metadata: ${expectedField}`);
}

assert(releasing.includes('https://community.obsidian.md'), 'RELEASING.md is missing the current Community directory URL');
assert(submission.includes('https://community.obsidian.md'), 'SUBMISSION.md is missing the current Community directory URL');
assert(releasing.includes('derivative'), 'RELEASING.md must preserve the derivative-work gate');
assert(submission.includes('Derivative-work gate'), 'SUBMISSION.md must preserve the derivative-work gate');

for (const runtimePath of ['data.json', 'seen-pulses']) {
  assert(!fs.existsSync(path.join(root, runtimePath)), `Runtime state must not be packaged: ${runtimePath}`);
}

console.log(`Release metadata is consistent for Unseen Changes Dot ${manifest.version}.`);
