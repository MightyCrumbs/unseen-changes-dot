'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class TFile {
  constructor(filePath, size = 0, mtime = 0) {
    this.path = filePath;
    this.extension = filePath.includes('.') ? filePath.split('.').pop() : '';
    this.stat = { size, mtime };
  }
}

class TFolder {
  constructor(folderPath, children = []) {
    this.path = folderPath;
    this.children = children;
  }
}

const obsidianMock = {
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  TFile,
  TFolder,
  Notice: class {},
  normalizePath: (value) => String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
};

const originalLoad = Module._load;
Module._load = function loadWithObsidianMock(request, parent, isMain) {
  if (request === 'obsidian') return obsidianMock;
  return originalLoad.call(this, request, parent, isMain);
};

const Plugin = require('../main.js');
Module._load = originalLoad;

function makePlugin() {
  const plugin = Object.create(Plugin.prototype);

  plugin.settings = plugin.createDefaultSettings();
  plugin.data = plugin.createEmptyData();
  plugin.syncFilePath = '.obsidian/plugins/unseen-changes-dot/data.json';
  plugin.legacySyncFilePath = '.obsidian/plugins/unseen-changes-dot/UnseenChangesState.json';
  plugin.seenPulseDir = '.obsidian/plugins/unseen-changes-dot/seen-pulses';
  plugin._seenPulseMtimeByFile = new Map();
  plugin._recentSeenPublishes = new Map();
  plugin._manualUnseenPaths = new Set();
  plugin.invalidateFolderMap = () => {};
  plugin.app = {
    vault: {
      adapter: null,
      getFiles: () => [],
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null
    }
  };

  return plugin;
}

test('release metadata and runtime exclusions stay aligned', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'manifest.json'), 'utf8'));
  const versions = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'versions.json'), 'utf8'));
  const packageData = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const main = fs.readFileSync(path.join(repositoryRoot, 'main.js'), 'utf8');
  const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const gitignore = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8').split(/\r?\n/);

  const mainVersion = main.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1];
  const readmeVersion = readme.match(/Current packaged version: `([^`]+)`/)?.[1];

  assert.equal(mainVersion, manifest.version);
  assert.equal(readmeVersion, manifest.version);
  assert.equal(packageData.version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  assert.ok(gitignore.includes('data.json'));
  assert.ok(gitignore.includes('seen-pulses/'));
  assert.equal(main.includes('localStorage'), false);
  assert.equal(main.includes('sessionStorage'), false);
});

test('startup inventory stays on Markdown unless attachment tracking is enabled', () => {
  const plugin = makePlugin();
  const note = new TFile('note.md', 10, 100);
  const image = new TFile('image.png', 20, 100);
  let allFileCalls = 0;
  let markdownFileCalls = 0;

  plugin.app.vault.getMarkdownFiles = () => {
    markdownFileCalls++;
    return [note];
  };
  plugin.app.vault.getFiles = () => {
    allFileCalls++;
    return [note, image];
  };

  assert.deepEqual(plugin.getTrackableFiles(), [note]);
  assert.equal(markdownFileCalls, 1);
  assert.equal(allFileCalls, 0);

  plugin.settings.trackAttachments = true;

  assert.deepEqual(plugin.getTrackableFiles(), [note, image]);
  assert.equal(markdownFileCalls, 1);
  assert.equal(allFileCalls, 1);
});

test('plugin data API persists signatures and initialization state', async () => {
  const plugin = makePlugin();
  let savedData = null;

  plugin.data.seenSignatureByPath['note.md'] = 'mdm:10:100';
  plugin.data.signaturesInitialized = true;
  plugin.saveData = async (data) => { savedData = data; };

  await plugin.writeSyncFile(plugin.data);

  assert.equal(savedData.seenSignatureByPath['note.md'], 'mdm:10:100');
  assert.equal(savedData.signaturesInitialized, true);
});

test('settings normalization rejects unsupported values', () => {
  const plugin = makePlugin();
  const originalCss = global.CSS;

  global.CSS = { supports: (_property, value) => value === '#123456' };

  try {
    const settings = plugin.normalizeSettings({
      dotDisplayMode: 'invalid',
      newShape: 'triangle',
      changedShape: 'square',
      newColor: 'not-a-color',
      changedColor: '#123456',
      syncPollingMs: 42
    });

    assert.equal(settings.dotDisplayMode, 'both');
    assert.equal(settings.newShape, 'circle');
    assert.equal(settings.changedShape, 'square');
    assert.equal(settings.newColor, '#74B3F5');
    assert.equal(settings.changedColor, '#123456');
    assert.equal(settings.syncPollingMs, 5000);
  } finally {
    global.CSS = originalCss;
  }
});

test('task markers match supported forms without matching similar words', () => {
  const plugin = makePlugin();

  assert.equal(plugin.bodyHasTaskHashtag('Work item #task'), true);
  assert.equal(plugin.bodyHasTaskHashtag('Work item #tasks/project'), true);
  assert.equal(plugin.bodyHasTaskHashtag('Work item #tasking'), false);
  assert.equal(plugin.frontmatterHasTaskMarker('---\ntags:\n  - task\n---\nNote'), true);
  assert.equal(plugin.frontmatterHasTaskMarker('---\ntask: false\n---\nNote'), false);
});

test('new state remains stronger than changed until the file is seen', () => {
  const plugin = makePlugin();
  const file = new TFile('note.md', 10, 100);

  plugin.setPathState(file.path, 'new', { now: 100 });
  assert.equal(plugin.setUnseenState(file, 'changed'), true);
  assert.equal(plugin.getPathState(file.path), 'new');

  plugin.setPathState(file.path, 'seen', { now: 200, tombstone: true });
  assert.equal(plugin.getPathState(file.path), 'seen');
  assert.equal(plugin.data.stateByPath[file.path].tombstone, true);
});

test('baseline reset preserves the current settings', async () => {
  const plugin = makePlugin();
  let savedOptions = null;

  plugin.settings = { ...plugin.settings, changedShape: 'square', syncPollingMs: 10000 };
  plugin.savePluginData = async (options) => { savedOptions = options; };
  plugin.refreshAllDots = () => {};

  await plugin.resetUnseenStateBaseline();

  assert.equal(plugin.data.settings.changedShape, 'square');
  assert.equal(plugin.data.settings.syncPollingMs, 10000);
  assert.equal(plugin.data.signaturesInitialized, true);
  assert.deepEqual(savedOptions, { forceOverwriteSyncFile: true });
});

test('manual unseen state survives while the file is active', async () => {
  const plugin = makePlugin();
  const file = new TFile('note.md', 10, 100);
  let markSeenCalls = 0;

  plugin._storageReady = true;
  plugin.ignoreSeenUntil = 0;
  plugin.startupUnseenPaths = new Set();
  plugin.preserveStartupUnseenUntil = 0;
  plugin.app.workspace = { getActiveFile: () => file, activeLeaf: null };
  plugin.app.metadataCache = { getFileCache: () => ({}) };
  plugin.refreshPathAndAncestors = () => {};
  plugin.refreshTabDots = () => {};
  plugin.queuePluginDataSave = () => {};
  plugin.markFileSeen = async () => { markSeenCalls++; };

  plugin.markFileUnseen(file, 'changed');

  assert.equal(plugin.getPathState(file.path), 'changed');
  assert.equal(plugin._manualUnseenPaths.has(file.path), true);

  await plugin.markActiveFileSeen(file, { force: true });
  assert.equal(markSeenCalls, 0);

  plugin.releaseManualUnseenHolds('other.md');
  await plugin.markActiveFileSeen(file, { force: true });
  assert.equal(markSeenCalls, 1);
});

test('a stale synced ignore flag cannot re-ignore a locally unmarked note', () => {
  const plugin = makePlugin();
  const local = plugin.createEmptyData();
  const remote = plugin.createEmptyData();

  remote.ignoredByPath['note.md'] = true;

  const merged = plugin.mergeStates(local, remote);
  assert.equal(merged.ignoredByPath['note.md'], undefined);
});

test('saving after a rename cannot restore the old synced path', async () => {
  const plugin = makePlugin();
  const remote = plugin.createEmptyData();
  let writtenData = null;

  plugin.data.stateByPath['new.md'] = {
    state: 'changed',
    seenAt: 0,
    changedAt: 200,
    tombstone: false
  };
  remote.stateByPath['old.md'] = {
    state: 'changed',
    seenAt: 0,
    changedAt: 100,
    tombstone: false
  };
  remote.stateByPath['remote.md'] = {
    state: 'new',
    seenAt: 0,
    changedAt: 150,
    tombstone: false
  };
  plugin.readSyncFile = async () => remote;
  plugin.writeSyncFile = async (data) => { writtenData = data; };
  await plugin.savePluginData({ deletedPaths: ['old.md'] });

  assert.equal(plugin.data.stateByPath['old.md'], undefined);
  assert.equal(plugin.data.stateByPath['new.md'].state, 'changed');
  assert.equal(plugin.data.stateByPath['remote.md'].state, 'new');
  assert.equal(writtenData.stateByPath['old.md'], undefined);
});

test('sync loading falls back through corrupt current data to valid legacy data', async () => {
  const plugin = makePlugin();
  const legacyData = plugin.createEmptyData();
  const warnings = [];
  const originalWarn = console.warn;

  plugin.loadData = async () => null;
  plugin.app.vault.adapter = {
    exists: async () => true,
    read: async (candidatePath) => candidatePath === plugin.syncFilePath
      ? '{corrupt'
      : JSON.stringify(legacyData)
  };
  console.warn = (...args) => warnings.push(args);

  try {
    const loaded = await plugin.readSyncFile();
    assert.equal(loaded.version, legacyData.version);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('one corrupt pulse does not block later valid pulses', async () => {
  const plugin = makePlugin();
  const file = new TFile('note.md', 10, 100);
  const warnings = [];
  const originalWarn = console.warn;

  plugin.data.stateByPath[file.path] = {
    state: 'changed',
    seenAt: 0,
    changedAt: 50,
    tombstone: false
  };
  plugin.rebuildLegacyRuntimeMaps(plugin.data);
  plugin.app.vault.getAbstractFileByPath = (filePath) => filePath === file.path ? file : null;
  plugin.app.vault.adapter = {
    exists: async () => true,
    list: async () => ({ files: [`${plugin.seenPulseDir}/bad.json`, `${plugin.seenPulseDir}/good.json`] }),
    stat: async () => ({ mtime: 100 }),
    read: async (pulsePath) => pulsePath.endsWith('/bad.json')
      ? '{corrupt'
      : JSON.stringify({
          version: 1,
          path: file.path,
          seenAt: 100,
          updatedAt: Date.now(),
          signature: 'md:10:abc',
          baselineSignature: 'mdm:10:100'
        })
  };
  plugin.matchesSeenSignature = async () => true;
  plugin.getBaselineSignature = async () => 'mdm:10:100';
  console.warn = (...args) => warnings.push(args);

  try {
    const result = await plugin.importSeenPulses();
    assert.equal(result.stateChanged, true);
    assert.equal(plugin.getPathState(file.path), 'seen');
    assert.equal(warnings.length, 1);

    await plugin.importSeenPulses();
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
