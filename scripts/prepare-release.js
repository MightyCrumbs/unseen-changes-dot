'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Refusing to prepare an invalid version: ${version}`);
}

const releaseRoot = path.join(root, 'release');
const outputDir = path.join(releaseRoot, `unseen-changes-dot-${version}`);

if (!outputDir.startsWith(`${releaseRoot}${path.sep}`)) {
  throw new Error('Resolved release output escaped the release directory');
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const assets = ['main.js', 'manifest.json', 'styles.css'];
const checksumLines = [];

for (const fileName of assets) {
  const source = path.join(root, fileName);
  const destination = path.join(outputDir, fileName);
  fs.copyFileSync(source, destination);
  const contents = fs.readFileSync(destination);
  const checksum = crypto.createHash('sha256').update(contents).digest('hex');
  checksumLines.push(`${checksum}  ${fileName}`);
}

fs.writeFileSync(path.join(outputDir, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);

console.log(`Prepared release files in ${path.relative(root, outputDir)}`);
for (const fileName of [...assets, 'SHA256SUMS']) {
  console.log(`- ${fileName}`);
}
