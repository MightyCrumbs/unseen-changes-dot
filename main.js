'use strict';

const obsidian = require('obsidian');

const DATA_VERSION = 8;
const PLUGIN_ID = 'unseen-changes-dot';
const LEGACY_SYNC_FILE_NAME = 'UnseenChangesState.json';
const PLUGIN_VERSION = '1.0.30';
const SEEN_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_PUBLISH_COOLDOWN_MS = 2000;
const PULSE_IMPORT_YIELD_EVERY = 25;
const STARTUP_HYDRATION_DELAY_MS = 2000;
const ATTACHMENT_STARTUP_HYDRATION_DELAY_MS = 4500;
const STARTUP_BOOTSTRAP_DELAY_MS = 1800;
const STARTUP_EXISTING_FILE_GRACE_MS = 10000;
const STARTUP_UNREAD_PRESERVE_MS = 15000;
const STARTUP_SEEN_DELAY_MS = 12000;
const SETTINGS_HYDRATION_DELAY_MS = 400;
const DOT_DISPLAY_MODES = ['both', 'new', 'changed'];
const DOT_SHAPES = ['circle', 'rounded', 'square', 'diamond'];
const DEFAULT_SETTINGS = {
  trackAttachments: false,
  syncPollingMs: 5000,
  fastStartupBaseline: true,
  dotDisplayMode: 'both',
  newColor: '#74B3F5',
  changedColor: 'var(--interactive-accent)',
  newShape: 'circle',
  changedShape: 'circle'
};
const SYNC_POLLING_OPTIONS = [1000, 3000, 5000, 10000, 30000];

class UnseenChangesDotPlugin extends obsidian.Plugin {

  async onload() {
    this._refreshScheduled = false;
    this._refreshTimer = null;
    this._saveTimer = null;
    this._isSaving = false;
    this._isImportingSync = false;
    this._explorerObserver = null;
    this._explorerRefreshBurstTimers = [];
    this._resumeRefreshTimer = null;
    this._cachedFolderMap = null;
    this._cachedFolderMapKey = null;
    this._pathRefreshTimers = new Map();
    this._ignoredInspectionTimers = new Map();
    this._activeSeenTimers = new Map();
    this._manualUnseenPaths = new Set();
    this._seenPulseMtimeByFile = new Map();
    this._recentSeenPublishes = new Map();
    this._syncPollTimer = null;
    this._startupHydrationTimer = null;
    this._deferredStartupTimer = null;
    this._isHydratingStartup = false;
    this._storageReady = false;
    this._isBootstrappingStorage = false;
    this.pluginConfigDir = obsidian.normalizePath(`${this.app.vault.configDir}/plugins/${PLUGIN_ID}`);
    this.syncFilePath = obsidian.normalizePath(`${this.pluginConfigDir}/data.json`);
    this.legacySyncFilePath = obsidian.normalizePath(`${this.pluginConfigDir}/${LEGACY_SYNC_FILE_NAME}`);
    this.seenPulseDir = obsidian.normalizePath(`${this.pluginConfigDir}/seen-pulses`);

    this.settings = this.createDefaultSettings();
    this.startupPaths = new Set();
    this.knownPaths = new Set();
    this.ignoreCreateEventsUntil = Date.now() + 3000;
    this.ignoreExistingFileEventsUntil = Date.now() + STARTUP_EXISTING_FILE_GRACE_MS;
    this.ignoreSeenUntil = Date.now() + STARTUP_SEEN_DELAY_MS;
    this.data = this.createEmptyData();
    this.startupUnseenPaths = new Set();
    this.preserveStartupUnseenUntil = 0;

    this.app.workspace.onLayoutReady(() => {
      this._deferredStartupTimer = window.setTimeout(() => {
        this._deferredStartupTimer = null;
        this.installExplorerObserver();
        this.scheduleRefresh();
        this.bootstrapStoredData()
          .catch((error) => console.warn('Unseen Changes Dot: deferred storage bootstrap failed', error));
      }, STARTUP_BOOTSTRAP_DELAY_MS);
    });

    this.registerInterval(window.setInterval(() => {
      this.markActiveFileSeen();
    }, 1000));

    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.scheduleResumeSyncRefresh();
      }
    });

    this.registerDomEvent(window, 'focus', () => {
      this.scheduleResumeSyncRefresh();
    });

    this.registerDomEvent(window, 'pageshow', () => {
      this.scheduleResumeSyncRefresh();
    });

    this.addSettingTab(new UnseenChangesDotSettingTab(this.app, this));

    this.addCommand({
      id: 'show-unseen-changes-status',
      name: 'Show unseen changes status',
      callback: () => {
        const file = this.getFrontFile();
        const status = this.isTrackableFile(file)
          ? `${file.path}: ${this.getRawUnseenState(file) || 'seen'}`
          : 'No active file';

        new obsidian.Notice(`Unseen Changes Dot ${PLUGIN_VERSION} loaded. ${status}`);
      }
    });

    this.addCommand({
      id: 'reset-unseen-state-baseline',
      name: 'Reset unseen state baseline',
      callback: async () => {
        await this.resetUnseenStateBaseline();

        new obsidian.Notice('Unseen Changes Dot baseline reset');
      }
    });

    this.addCommand({
      id: 'show-storage-debug',
      name: 'Show storage debug',
      callback: async () => {
        const pluginData = await this.readSyncFile();

        const message = [
          `memory ${this.countUnseen(this.data)}/${this.countSignatures(this.data)}`,
          `plugin-data ${this.countUnseen(pluginData)}/${this.countSignatures(pluginData)}`
        ].join(' | ');

        new obsidian.Notice(`Unseen Changes Dot storage: ${message}`, 12000);
      }
    });

    this.addCommand({
      id: 'mark-current-file-seen',
      name: 'Mark current file as seen',
      checkCallback: (checking) => {
        const file = this.getFrontFile();
        if (!this.isTrackableFile(file)) return false;

        if (!checking) {
          this.markFileSeen(file, { overrideStartupDelay: true })
            .catch((error) => console.warn('Unseen Changes Dot: could not mark current file as seen', error));
        }
        return true;
      }
    });

    this.addCommand({
      id: 'mark-current-file-unseen',
      name: 'Mark current file as unseen',
      checkCallback: (checking) => {
        const file = this.getFrontFile();
        if (!this.isTrackableFile(file)) return false;

        if (!checking) this.markFileUnseen(file, 'changed');
        return true;
      }
    });

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.releaseManualUnseenHolds();
        this.scheduleActiveSeenPublishes();
        this.scheduleExplorerRefreshBurst();
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.releaseManualUnseenHolds(file?.path || null);

        if (this.isTrackableFile(file)) {
          this.scheduleFileSeenPublishes(file);
          this.scheduleExplorerRefreshBurst();
          return;
        }

        this.scheduleActiveSeenPublishes();
        this.scheduleExplorerRefreshBurst();
      })
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.installExplorerObserver();
        this.scheduleActiveSeenPublishes();
        this.scheduleExplorerRefreshBurst();
        this.scheduleRefresh();
      })
    );

    this.registerEvent(
      this.app.metadataCache.on('changed', async (file) => {
        if (!this._storageReady) return;
        if (!this.isMarkdownFile(file)) return;
        if (await this.handleStartupExistingFileEvent(file)) return;

        const mayBeIgnored = Boolean(this.data.ignoredByPath[file.path]) || this.metadataHasTaskMarker(file);

        if (mayBeIgnored && await this.updateIgnoredState(file)) {
          await this.markFileSeen(file);
          return;
        }

        if (this.isFileActive(file) && Date.now() >= this.ignoreSeenUntil) {
          await this.markFileSeen(file);
          return;
        }

        this.showUnseenNow(file, 'changed');
        this.scheduleIgnoredInspection(file);
      })
    );

    this.registerEvent(this.app.vault.on('create', (file) => this.onFileCreated(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => this.onFileModified(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onFileDeleted(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRenamed(file, oldPath)));

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, abstractFile) => {
        if (abstractFile instanceof obsidian.TFile) {
          const currentState = this.getPathState(abstractFile.path);
          const isMarkedUnseen = currentState === 'new' || currentState === 'changed';

          menu.addItem((item) => {
            item
              .setTitle(isMarkedUnseen ? 'Mark as seen' : 'Mark as unseen')
              .setIcon(isMarkedUnseen ? 'check' : 'dot')
              .onClick(async () => {
                if (isMarkedUnseen) {
                  await this.markFileSeen(abstractFile, { overrideStartupDelay: true });
                } else {
                  this.markFileUnseen(abstractFile, 'changed');
                }
              });
          });

          return;
        }

        if (!(abstractFile instanceof obsidian.TFolder)) return;

        const unseenFiles = this.getUnseenFilesInFolder(abstractFile);

        if (unseenFiles.length > 0) {
          menu.addItem((item) => {
            item
              .setTitle(`Mark all as seen (${unseenFiles.length})`)
              .setIcon('check-check')
              .onClick(async () => {
                let changed = false;

                for (const file of unseenFiles) {
                  if (this.clearUnseenState(file.path)) changed = true;

                  const sig = await this.getBaselineSignature(file);
                  if (this.data.seenSignatureByPath[file.path] !== sig) {
                    this.data.seenSignatureByPath[file.path] = sig;
                    changed = true;
                  }
                }

                if (changed) {
                  await this.savePluginData();
                  this.refreshAllDots();
                }

                new obsidian.Notice(`Marked ${unseenFiles.length} files as seen`);
              });
          });
        }

        const trackableFiles = this.getTrackableFilesInFolder(abstractFile)
          .filter((file) => !this.isIgnoredFile(file) && !this.isFileActive(file));

        if (trackableFiles.length > 0) {
          menu.addItem((item) => {
            item
              .setTitle(`Mark all as unseen (${trackableFiles.length})`)
              .setIcon('dot')
              .onClick(async () => {
                for (const file of trackableFiles) {
                  this.setPathState(file.path, 'changed');
                }

                await this.savePluginData();
                this.refreshAllDots();

                new obsidian.Notice(`Marked ${trackableFiles.length} files as unseen`);
              });
          });
        }
      })
    );
  }

  onunload() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }

    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    if (this._explorerObserver) {
      this._explorerObserver.disconnect();
      this._explorerObserver = null;
    }

    for (const id of this._explorerRefreshBurstTimers) {
      clearTimeout(id);
    }

    this._explorerRefreshBurstTimers = [];

    if (this._resumeRefreshTimer) {
      clearTimeout(this._resumeRefreshTimer);
      this._resumeRefreshTimer = null;
    }

    if (this._syncPollTimer) {
      clearInterval(this._syncPollTimer);
      this._syncPollTimer = null;
    }

    if (this._startupHydrationTimer) {
      clearTimeout(this._startupHydrationTimer);
      this._startupHydrationTimer = null;
    }

    if (this._deferredStartupTimer) {
      clearTimeout(this._deferredStartupTimer);
      this._deferredStartupTimer = null;
    }

    for (const ids of this._pathRefreshTimers.values()) {
      for (const id of ids) clearTimeout(id);
    }

    this._pathRefreshTimers.clear();

    for (const id of this._ignoredInspectionTimers.values()) {
      clearTimeout(id);
    }

    this._ignoredInspectionTimers.clear();

    for (const ids of this._activeSeenTimers.values()) {
      for (const id of ids) clearTimeout(id);
    }

    this._activeSeenTimers.clear();
    this._manualUnseenPaths.clear();
    this._seenPulseMtimeByFile.clear();
    this._recentSeenPublishes.clear();

    document.querySelectorAll('.unread-dot-stack, .unread-dot').forEach(el => el.remove());
  }

  createEmptyData() {
    return {
      version: DATA_VERSION,
      stateByPath: {},
      ignoredByPath: {},
      seenSignatureByPath: {},
      signaturesInitialized: false,
      settings: this.createDefaultSettings(),
      updatedAt: 0,
      unseenByPath: {},
      seenAtByPath: {},
      changedAtByPath: {}
    };
  }

  createDefaultSettings() {
    return { ...DEFAULT_SETTINGS };
  }

  getTrackableFiles() {
    const files = this.settings.trackAttachments
      ? this.app.vault.getFiles()
      : this.app.vault.getMarkdownFiles();

    return files.filter((file) => this.isTrackableFile(file));
  }

  captureStartupPaths() {
    this.startupPaths = new Set(this.getTrackableFiles().map((file) => file.path));
    this.knownPaths = new Set(this.startupPaths);
  }

  async resetUnseenStateBaseline() {
    const currentSettings = { ...this.settings };
    this.data = this.createEmptyData();
    this.data.settings = currentSettings;

    for (const file of this.getTrackableFiles()) {
      this.data.seenSignatureByPath[file.path] = await this.getBaselineSignature(file);
    }

    this.data.signaturesInitialized = true;
    this.rebuildLegacyRuntimeMaps(this.data);

    await this.savePluginData({ forceOverwriteSyncFile: true });

    this.invalidateFolderMap();
    this.refreshAllDots();
  }

  normalizeSettings(settings) {
    const normalized = {
      ...this.createDefaultSettings(),
      ...(settings && typeof settings === 'object' ? settings : {})
    };

    normalized.trackAttachments = Boolean(normalized.trackAttachments);
    normalized.fastStartupBaseline = Boolean(normalized.fastStartupBaseline);
    normalized.dotDisplayMode = DOT_DISPLAY_MODES.includes(normalized.dotDisplayMode)
      ? normalized.dotDisplayMode
      : DEFAULT_SETTINGS.dotDisplayMode;
    normalized.newColor = this.normalizeColorSetting(normalized.newColor, DEFAULT_SETTINGS.newColor);
    normalized.changedColor = this.normalizeColorSetting(normalized.changedColor, DEFAULT_SETTINGS.changedColor);
    normalized.newShape = DOT_SHAPES.includes(normalized.newShape)
      ? normalized.newShape
      : DEFAULT_SETTINGS.newShape;
    normalized.changedShape = DOT_SHAPES.includes(normalized.changedShape)
      ? normalized.changedShape
      : DEFAULT_SETTINGS.changedShape;

    const syncPollingMs = Number(normalized.syncPollingMs || DEFAULT_SETTINGS.syncPollingMs);
    normalized.syncPollingMs = SYNC_POLLING_OPTIONS.includes(syncPollingMs)
      ? syncPollingMs
      : DEFAULT_SETTINGS.syncPollingMs;

    return normalized;
  }

  normalizeColorSetting(value, fallback) {
    const normalized = String(value || '').trim();
    if (!normalized) return fallback;
    if (normalized.startsWith('var(')) return normalized;

    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
      return CSS.supports('color', normalized) ? normalized : fallback;
    }

    return normalized;
  }

  setSettings(settings) {
    this.settings = this.normalizeSettings(settings);

    if (this.data && typeof this.data === 'object') {
      this.data.settings = { ...this.settings };
    }
  }

  async saveSettings(previousSettings = null) {
    const previous = previousSettings
      ? this.normalizeSettings(previousSettings)
      : this.normalizeSettings(this.data?.settings || this.settings);

    this.setSettings(this.settings);
    this.startSyncPolling();
    this.invalidateFolderMap();
    this.refreshAllDots();
    await this.savePluginData({ forceOverwriteSyncFile: true });

    if (this.shouldHydrateAfterSettingsChange(previous, this.settings)) {
      this.captureStartupPaths();
      this.data.signaturesInitialized = false;
      await this.persistPluginDataSnapshot();
      this.scheduleStartupHydration(SETTINGS_HYDRATION_DELAY_MS);
    }
  }

  async bootstrapStoredData() {
    if (this._storageReady || this._isBootstrappingStorage) return;

    this._isBootstrappingStorage = true;

    try {
      this.data = await this.loadStoredData();
      this.captureStartupPaths();
      this.startupUnseenPaths = new Set(Object.keys(this.data?.unseenByPath || {}));
      this.preserveStartupUnseenUntil = Date.now() + STARTUP_UNREAD_PRESERVE_MS;
      this._storageReady = true;
      this.startSyncPolling();
      this.invalidateFolderMap();
      this.refreshAllDots();
      this.scheduleStartupHydration();
    } finally {
      this._isBootstrappingStorage = false;
    }
  }

  async populateMissingSeenSignatures() {
    if (this.data.signaturesInitialized) return false;

    let processed = 0;
    let changed = false;

    for (const file of this.getTrackableFiles()) {
      if (this.data.seenSignatureByPath[file.path]) continue;

      this.data.seenSignatureByPath[file.path] = await this.getBaselineSignature(file);
      processed++;
      changed = true;

      if (processed % 250 === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    this.data.signaturesInitialized = true;
    return changed;
  }

  shouldHydrateAfterSettingsChange(previousSettings, nextSettings) {
    return !previousSettings.trackAttachments && nextSettings.trackAttachments;
  }

  scheduleStartupHydration(delay = null) {
    const effectiveDelay = typeof delay === 'number'
      ? delay
      : (this.settings.trackAttachments ? ATTACHMENT_STARTUP_HYDRATION_DELAY_MS : STARTUP_HYDRATION_DELAY_MS);

    if (this._startupHydrationTimer) {
      clearTimeout(this._startupHydrationTimer);
    }

    this._startupHydrationTimer = window.setTimeout(() => {
      this._startupHydrationTimer = null;
      this.runStartupHydration()
        .catch((error) => console.warn('Unseen Changes Dot: deferred startup hydration failed', error));
    }, effectiveDelay);
  }

  async runStartupHydration() {
    if (!this._storageReady) return;
    if (this._isHydratingStartup) return;

    this._isHydratingStartup = true;

    try {
      const signaturesChanged = await this.initializeSeenSignatures();
      await this.importSyncFileState();

      if (signaturesChanged) {
        this.refreshAllDots();
      }
    } finally {
      this._isHydratingStartup = false;
    }
  }

  startSyncPolling() {
    if (this._syncPollTimer) {
      clearInterval(this._syncPollTimer);
    }

    this._syncPollTimer = window.setInterval(() => {
      this.importSyncFileState();
    }, this.settings.syncPollingMs);
  }

  normalizeStateEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const state = entry.state === 'new' || entry.state === 'changed' ? entry.state : 'seen';
    const seenAt = Number(entry.seenAt || 0);
    const changedAt = Number(entry.changedAt || 0);
    const tombstone = Boolean(entry.tombstone || (state === 'seen' && changedAt > 0));

    if (state === 'seen' && !tombstone && changedAt === 0) return null;

    return { state, seenAt, changedAt, tombstone };
  }

  pruneStateForRuntime(data) {
    if (!data?.stateByPath) return data;

    const stateByPath = {};

    for (const [path, rawEntry] of Object.entries(data.stateByPath || {})) {
      const entry = this.normalizeStateEntry(rawEntry);
      if (!entry) continue;
      stateByPath[path] = entry;
    }

    data.stateByPath = stateByPath;
    return data;
  }

  compactStateForSync(data, now = Date.now()) {
    const normalized = this.normalizeData(data) || this.createEmptyData();
    const stateByPath = {};

    for (const [path, rawEntry] of Object.entries(normalized.stateByPath || {})) {
      const entry = this.normalizeStateEntry(rawEntry);
      if (!entry) continue;

      if (entry.state === 'new' || entry.state === 'changed') {
        stateByPath[path] = entry;
        continue;
      }

      if (entry.tombstone && entry.seenAt && now - entry.seenAt <= SEEN_TOMBSTONE_TTL_MS) {
        stateByPath[path] = entry;
      }
    }

    return {
      version: DATA_VERSION,
      stateByPath,
      ignoredByPath: normalized.ignoredByPath || {},
      seenSignatureByPath: normalized.seenSignatureByPath || {},
      signaturesInitialized: Boolean(normalized.signaturesInitialized),
      settings: this.normalizeSettings(normalized.settings),
      updatedAt: normalized.updatedAt || now
    };
  }

  rebuildLegacyRuntimeMaps(data) {
    this.pruneStateForRuntime(data);

    const unseenByPath = {};
    const seenAtByPath = {};
    const changedAtByPath = {};

    for (const [path, entry] of Object.entries(data.stateByPath || {})) {
      if (!entry || typeof entry !== 'object') continue;

      if (entry.state === 'new' || entry.state === 'changed') {
        unseenByPath[path] = entry.state;
      }

      if (entry.seenAt) {
        seenAtByPath[path] = Number(entry.seenAt || 0);
      }

      if (entry.changedAt) {
        changedAtByPath[path] = Number(entry.changedAt || 0);
      }
    }

    data.unseenByPath = unseenByPath;
    data.seenAtByPath = seenAtByPath;
    data.changedAtByPath = changedAtByPath;

    return data;
  }

  getPathState(path) {
    const entry = this.data.stateByPath?.[path];
    return entry?.state || 'seen';
  }

  setPathState(path, state, options = {}) {
    if (!path) return false;
    if (state !== 'seen' && state !== 'new' && state !== 'changed') return false;

    if (!this.data.stateByPath) this.data.stateByPath = {};

    const now = options.now || Date.now();
    const previous = this.data.stateByPath[path] || {};
    const previousState = previous.state || 'seen';

    const entry = {
      state,
      seenAt: Number(previous.seenAt || 0),
      changedAt: Number(previous.changedAt || 0),
      tombstone: Boolean(previous.tombstone)
    };

    if (state === 'seen') {
      entry.seenAt = Math.max(entry.seenAt || 0, now);
      entry.tombstone = Boolean(options.tombstone || entry.tombstone || previousState === 'new' || previousState === 'changed');

      if (options.changedAt !== undefined) {
        entry.changedAt = Math.max(entry.changedAt || 0, Number(options.changedAt || 0));
      }
    } else {
      entry.changedAt = Math.max(entry.changedAt || 0, now);
      entry.tombstone = false;

      if (options.seenAt !== undefined) {
        entry.seenAt = Math.max(entry.seenAt || 0, Number(options.seenAt || 0));
      }
    }

    this.data.stateByPath[path] = entry;
    this.rebuildLegacyRuntimeMaps(this.data);

    const changed = previousState !== state
      || Number(previous.seenAt || 0) !== Number(entry.seenAt || 0)
      || Number(previous.changedAt || 0) !== Number(entry.changedAt || 0)
      || Boolean(previous.tombstone) !== Boolean(entry.tombstone);

    if (changed) {
      this.invalidateFolderMap();
      return true;
    }

    return false;
  }

  deletePathState(path) {
    if (!path) return;

    if (this.data.stateByPath) delete this.data.stateByPath[path];
    if (this.data.unseenByPath) delete this.data.unseenByPath[path];
    if (this.data.seenAtByPath) delete this.data.seenAtByPath[path];
    if (this.data.changedAtByPath) delete this.data.changedAtByPath[path];

    this.invalidateFolderMap();
  }

  async loadStoredData() {
    const syncFileData = await this.readSyncFile();

    const settingsSource = syncFileData?.settings || this.settings;
    this.setSettings(settingsSource);
    let data;

    if (syncFileData) {
      data = this.normalizeData(syncFileData);
      data.settings = { ...this.settings };
      data = this.rebuildLegacyRuntimeMaps(data);

      this.data = data;
      await this.applyRemoteSeenSignatures(syncFileData);

      data = this.data;
    } else {
      data = this.createEmptyData();
    }

    data.settings = { ...this.settings };
    this.data = data;
    this.pruneMissingRuntimeEntries();
    await this.persistPluginDataSnapshot();

    return data;
  }

  pruneMissingRuntimeEntries() {
    const candidatePaths = new Set([
      ...Object.keys(this.data?.stateByPath || {}),
      ...Object.keys(this.data?.ignoredByPath || {}),
      ...Object.keys(this.data?.seenSignatureByPath || {})
    ]);
    let stateChanged = false;
    let signatureChanged = false;

    for (const path of candidatePaths) {
      if (!path || this.isPluginStatePath(path)) continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) continue;

      if (this.data.stateByPath?.[path] !== undefined) {
        delete this.data.stateByPath[path];
        stateChanged = true;
      }

      if (this.data.ignoredByPath?.[path] !== undefined) {
        delete this.data.ignoredByPath[path];
        stateChanged = true;
      }

      if (this.data.seenSignatureByPath?.[path] !== undefined) {
        delete this.data.seenSignatureByPath[path];
        signatureChanged = true;
      }
    }

    if (!stateChanged && !signatureChanged) return false;

    this.rebuildLegacyRuntimeMaps(this.data);
    if (stateChanged) this.invalidateFolderMap();
    return true;
  }

  async readSyncFile() {
    try {
      const data = await this.loadData();
      const normalized = this.normalizeData(data);
      if (normalized) return normalized;
    } catch (error) {
      console.warn('Unseen Changes Dot: could not read plugin data', error);
    }

    return this.readSyncFileFromAdapter();
  }

  async readSyncFileFromAdapter() {
    const adapter = this.app?.vault?.adapter;
    if (!adapter) return null;

    if (typeof adapter.read !== 'function') return null;
    const candidatePaths = [this.syncFilePath, this.legacySyncFilePath];

    for (const candidatePath of candidatePaths) {
      try {
        if (typeof adapter.exists === 'function' && !(await adapter.exists(candidatePath))) {
          continue;
        }

        const raw = await adapter.read(candidatePath);
        if (!raw) continue;

        const normalized = this.normalizeData(JSON.parse(raw));
        if (normalized) return normalized;
      } catch (error) {
        console.warn(`Unseen Changes Dot: could not read sync candidate ${candidatePath}`, error);
      }
    }

    return null;
  }

  async writeSyncFile(data) {
    const syncData = {
      ...this.compactStateForSync(data)
    };

    try {
      await this.saveData(syncData);
    } catch (error) {
      console.warn('Unseen Changes Dot: could not write plugin data', error);
    }
  }

  async ensureAdapterDir(dirPath) {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.exists !== 'function' || typeof adapter.mkdir !== 'function') return;

    const parts = String(dirPath || '').split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;

      if (await adapter.exists(current)) continue;
      await adapter.mkdir(current);
    }
  }

  getSeenPulsePath(path) {
    return obsidian.normalizePath(`${this.seenPulseDir}/${this.hashString(path)}.json`);
  }

  shouldSkipSeenPulse(path, signature, now = Date.now()) {
    const previous = this._recentSeenPublishes.get(path);
    if (!previous) return false;

    return previous.signature === signature
      && now - previous.at < SEEN_PUBLISH_COOLDOWN_MS;
  }

  rememberSeenPulse(path, signature, at = Date.now()) {
    this._recentSeenPublishes.set(path, { signature, at });
  }

  async deleteSeenPulseFile(pulsePath) {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.remove !== 'function') return false;

    try {
      await adapter.remove(pulsePath);
      this._seenPulseMtimeByFile.delete(pulsePath);
      return true;
    } catch (error) {
      console.warn('Unseen Changes Dot: could not delete seen pulse', error);
      return false;
    }
  }

  async writeSeenPulse(path) {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.write !== 'function') return;

    const entry = this.data.stateByPath?.[path];
    const seenAt = Number(entry?.seenAt || Date.now());
    const now = Date.now();
    const file = this.app.vault.getAbstractFileByPath(path);
    const baselineSignature = this.isTrackableFile(file)
      ? await this.getBaselineSignature(file)
      : null;
    const signature = this.isTrackableFile(file)
      ? await this.getCurrentSignature(file)
      : (this.data.seenSignatureByPath?.[path] || null);

    if (this.shouldSkipSeenPulse(path, signature || baselineSignature, now)) {
      return false;
    }

    const pulse = {
      version: 1,
      path,
      seenAt,
      updatedAt: now,
      signature,
      baselineSignature
    };

    const pulsePath = this.getSeenPulsePath(path);

    try {
      await this.ensureAdapterDir(this.seenPulseDir);
      await adapter.write(pulsePath, JSON.stringify(pulse, null, 2));
      this._seenPulseMtimeByFile.delete(pulsePath);
      this.rememberSeenPulse(path, signature || baselineSignature, now);
      return true;
    } catch (error) {
      console.warn('Unseen Changes Dot: could not write seen pulse', error);
      return false;
    }
  }

  async importSeenPulses() {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.list !== 'function' || typeof adapter.read !== 'function') {
      return {
        stateChanged: false,
        signatureChanged: false,
        pulseFilesChanged: false
      };
    }

    try {
      if (typeof adapter.exists === 'function' && !(await adapter.exists(this.seenPulseDir))) {
        return {
          stateChanged: false,
          signatureChanged: false,
          pulseFilesChanged: false
        };
      }

      const listed = await adapter.list(this.seenPulseDir);
      const files = listed?.files || [];
      const now = Date.now();
      let stateChanged = false;
      let signatureChanged = false;
      let pulseFilesChanged = false;
      let processed = 0;

      for (const pulsePath of files) {
        if (!pulsePath.endsWith('.json')) continue;

        const stat = typeof adapter.stat === 'function'
          ? await adapter.stat(pulsePath).catch(() => null)
          : null;
        const mtime = Number(stat?.mtime || 0);

        if (mtime && this._seenPulseMtimeByFile.get(pulsePath) === mtime) {
          continue;
        }

        let raw;

        try {
          raw = await adapter.read(pulsePath);
        } catch (error) {
          console.warn(`Unseen Changes Dot: could not read seen pulse ${pulsePath}`, error);
          continue;
        }

        let pulse;

        try {
          pulse = JSON.parse(raw);
        } catch (error) {
          if (mtime) this._seenPulseMtimeByFile.set(pulsePath, mtime);
          console.warn(`Unseen Changes Dot: could not parse seen pulse ${pulsePath}`, error);
          continue;
        }

        this._seenPulseMtimeByFile.set(pulsePath, mtime || Date.now());

        if (!pulse || pulse.version !== 1 || !pulse.path) continue;

        const pulseUpdatedAt = Number(pulse.updatedAt || pulse.seenAt || 0);
        if (pulseUpdatedAt && now - pulseUpdatedAt > SEEN_TOMBSTONE_TTL_MS) {
          if (await this.deleteSeenPulseFile(pulsePath)) {
            pulseFilesChanged = true;
          }
          continue;
        }

        const path = String(pulse.path);
        if (this.isPluginStatePath(path)) continue;

        const seenAt = Number(pulse.seenAt || 0);
        if (!seenAt) continue;

        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
          if (this.data.stateByPath?.[path] !== undefined) {
            this.deletePathState(path);
            stateChanged = true;
          }

          if (this.data.ignoredByPath?.[path] !== undefined) {
            delete this.data.ignoredByPath[path];
            stateChanged = true;
          }

          if (this.data.seenSignatureByPath?.[path] !== undefined) {
            delete this.data.seenSignatureByPath[path];
            signatureChanged = true;
          }

          if (await this.deleteSeenPulseFile(pulsePath)) {
            pulseFilesChanged = true;
          }

          continue;
        }

        if (!this.isTrackableFile(file)) continue;

        const entry = this.data.stateByPath?.[path];
        const changedAt = Number(entry?.changedAt || 0);
        const isCurrentlyUnseen = entry?.state === 'new' || entry?.state === 'changed';
        let pulseMatchesCurrentFile = false;

        if (this.isTrackableFile(file)) {
          const comparableSignature = pulse.signature || pulse.baselineSignature || null;
          pulseMatchesCurrentFile = Boolean(
            comparableSignature
            && await this.matchesSeenSignature(file, comparableSignature)
          );

          const localSignature = pulseMatchesCurrentFile
            ? (pulse.signature || comparableSignature)
            : await this.getBaselineSignature(file);

          if ((!isCurrentlyUnseen || pulseMatchesCurrentFile)
            && localSignature
            && this.data.seenSignatureByPath[path] !== localSignature) {
            this.data.seenSignatureByPath[path] = localSignature;
            signatureChanged = true;
          }
        } else if (pulse.signature && this.data.seenSignatureByPath[path] !== pulse.signature) {
          this.data.seenSignatureByPath[path] = pulse.signature;
          signatureChanged = true;
        }

        if ((entry?.state === 'new' || entry?.state === 'changed') && changedAt > seenAt && !pulseMatchesCurrentFile) {
          continue;
        }

        if (this.setPathState(path, 'seen', { tombstone: true, now: Math.max(seenAt, changedAt), changedAt })) {
          stateChanged = true;
        }

        processed++;
        if (processed % PULSE_IMPORT_YIELD_EVERY === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }

      return { stateChanged, signatureChanged, pulseFilesChanged };
    } catch (error) {
      console.warn('Unseen Changes Dot: could not import seen pulses', error);
      return {
        stateChanged: false,
        signatureChanged: false,
        pulseFilesChanged: false
      };
    }
  }

  normalizeData(data) {
    if (!data) return null;

    if (data.version === DATA_VERSION || data.version === 7) {
      const normalized = {
        version: DATA_VERSION,
        stateByPath: data.stateByPath || {},
        ignoredByPath: data.ignoredByPath || {},
        seenSignatureByPath: data.seenSignatureByPath || {},
        signaturesInitialized: Boolean(data.signaturesInitialized),
        settings: this.normalizeSettings(data.settings),
        updatedAt: Number(data.updatedAt || 0)
      };

      return this.rebuildLegacyRuntimeMaps(normalized);
    }

    if (data.version === 6) {
      const stateByPath = {};
      const unseenByPath = data.unseenByPath || {};
      const seenAtByPath = data.seenAtByPath || {};
      const changedAtByPath = data.changedAtByPath || {};

      const paths = new Set([
        ...Object.keys(unseenByPath),
        ...Object.keys(seenAtByPath),
        ...Object.keys(changedAtByPath)
      ]);

      for (const path of paths) {
        const unseenState = unseenByPath[path];
        const seenAt = Number(seenAtByPath[path] || 0);
        const changedAt = Number(changedAtByPath[path] || 0);

        let state = 'seen';

        if ((unseenState === 'new' || unseenState === 'changed') && changedAt > seenAt) {
          state = unseenState;
        }

        stateByPath[path] = { state, seenAt, changedAt };
      }

      const migrated = {
        version: DATA_VERSION,
        stateByPath,
        ignoredByPath: data.ignoredByPath || {},
        seenSignatureByPath: data.seenSignatureByPath || {},
        signaturesInitialized: Boolean(data.signaturesInitialized),
        settings: this.createDefaultSettings(),
        updatedAt: Number(data.updatedAt || 0)
      };

      return this.rebuildLegacyRuntimeMaps(migrated);
    }

    return null;
  }

  mergeStoredData(candidates) {
    const valid = candidates.filter(Boolean);
    if (valid.length === 0) return null;
    if (valid.length === 1) return this.normalizeData(JSON.parse(JSON.stringify(valid[0])));

    return valid.reduce((a, b) => this.mergeStates(a, b));
  }

  mergeStates(a, b) {
    a = this.normalizeData(a) || this.createEmptyData();
    b = this.normalizeData(b) || this.createEmptyData();

    const stateByPath = {};
    // Ignore state comes from the current local file content. Keeping the local
    // view prevents stale sync data from re-ignoring a note after its task marker
    // has been removed.
    const ignoredByPath = { ...(a.ignoredByPath || {}) };

    const paths = new Set([
      ...Object.keys(a.stateByPath || {}),
      ...Object.keys(b.stateByPath || {})
    ]);

    for (const path of paths) {
      const entryA = a.stateByPath?.[path] || {};
      const entryB = b.stateByPath?.[path] || {};

      const seenAt = Math.max(Number(entryA.seenAt || 0), Number(entryB.seenAt || 0));
      const changedAt = Math.max(Number(entryA.changedAt || 0), Number(entryB.changedAt || 0));
      const tombstone = Boolean(entryA.tombstone || entryB.tombstone);

      let state = 'seen';

      if (ignoredByPath[path]) {
        state = 'seen';
      } else if (changedAt > seenAt) {
        const states = [entryA.state, entryB.state];
        state = states.includes('new') ? 'new' : 'changed';
      } else {
        state = 'seen';
      }

      stateByPath[path] = { state, seenAt, changedAt, tombstone: state === 'seen' && tombstone };
    }

    const merged = {
      version: DATA_VERSION,
      stateByPath,
      ignoredByPath,
      seenSignatureByPath: a.seenSignatureByPath || {},
      signaturesInitialized: Boolean(a.signaturesInitialized),
      settings: this.normalizeSettings(b.settings || a.settings),
      updatedAt: Math.max(Number(a.updatedAt || 0), Number(b.updatedAt || 0))
    };

    return this.rebuildLegacyRuntimeMaps(merged);
  }

  async applyRemoteSeenSignatures(remoteData) {
    if (!remoteData?.stateByPath) return false;

    let changed = false;

    for (const [path, entry] of Object.entries(remoteData.stateByPath)) {
      if (!entry || entry.state !== 'seen') continue;
      if (this.getPathState(path) === 'new' || this.getPathState(path) === 'changed') continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!this.isTrackableFile(file)) continue;

      const signature = await this.getBaselineSignature(file);
      if (!signature) continue;

      if (this.data.seenSignatureByPath[path] !== signature) {
        this.data.seenSignatureByPath[path] = signature;
        changed = true;
      }
    }

    return changed;
  }

  async reconcileUnseenWithLocalSeenSignatures() {
    let changed = false;

    for (const [path, state] of Object.entries(this.data.unseenByPath || {})) {
      if (state !== 'new' && state !== 'changed') continue;

      const seenSignature = this.data.seenSignatureByPath?.[path];
      if (!seenSignature) continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!this.isTrackableFile(file)) continue;

      const matches = await this.matchesSeenSignature(file, seenSignature);
      if (!matches) continue;

      const entry = this.data.stateByPath?.[path] || {};
      const changedAt = Number(entry.changedAt || 0);
      const now = Math.max(Date.now(), changedAt);

      if (this.setPathState(path, 'seen', { tombstone: true, now, changedAt })) {
        changed = true;
      }
    }

    return changed;
  }

  async importSyncFileState() {
    if (!this._storageReady) return;
    if (this._isSaving) return;
    if (this._isImportingSync) return;

    this._isImportingSync = true;

    try {
      const diskData = await this.readSyncFile();
      const beforeSnapshot = this.captureRuntimeSnapshot();
      let remoteSignaturesChanged = false;

      if (diskData) {
        const merged = this.mergeStates(this.data, diskData);
        this.data = merged;

        remoteSignaturesChanged = await this.applyRemoteSeenSignatures(diskData);
      }

      const pulseChanges = await this.importSeenPulses();
      const reconciledChanged = await this.reconcileUnseenWithLocalSeenSignatures();
      this.rebuildLegacyRuntimeMaps(this.data);
      const afterSnapshot = this.captureRuntimeSnapshot();
      const stateChanged = pulseChanges.stateChanged
        || beforeSnapshot.unseenHash !== afterSnapshot.unseenHash;
      const ignoredChanged = beforeSnapshot.ignoredHash !== afterSnapshot.ignoredHash;
      const signaturesChanged = remoteSignaturesChanged
        || pulseChanges.signatureChanged
        || pulseChanges.pulseFilesChanged
        || beforeSnapshot.signatureEntries !== afterSnapshot.signatureEntries
        || beforeSnapshot.signatureKeyHash !== afterSnapshot.signatureKeyHash;

      if (stateChanged || ignoredChanged) {
        this.invalidateFolderMap();
        this.refreshAllDots();
        this.scheduleExplorerRefreshBurst();
      }

      if (stateChanged || ignoredChanged || signaturesChanged) {
        await this.persistPluginDataSnapshot();
      }

      if (pulseChanges.stateChanged || reconciledChanged) {
        this.data.updatedAt = Date.now();
        await this.writeSyncFile(this.data);
      }
    } catch (error) {
      console.warn('Unseen Changes Dot: could not import sync state', error);
    } finally {
      this._isImportingSync = false;
    }
  }

  countUnseen(data) {
    if (!data) return 'missing';

    const normalized = this.normalizeData(data);
    if (!normalized) return 'missing';

    return Object.values(normalized.stateByPath || {})
      .filter((entry) => entry?.state === 'new' || entry?.state === 'changed')
      .length;
  }

  countSignatures(data) {
    if (!data) return 'missing';
    return Object.keys(data.seenSignatureByPath || {}).length;
  }

  captureRuntimeSnapshot(data = this.data) {
    const stateEntries = Object.keys(data?.stateByPath || {}).length;
    const ignoredEntries = Object.keys(data?.ignoredByPath || {}).length;
    const signatureEntries = Object.keys(data?.seenSignatureByPath || {}).length;
    let newEntries = 0;
    let changedEntries = 0;
    const unseenEntries = [];

    for (const [path, state] of Object.entries(data?.unseenByPath || {})) {
      if (state === 'new') newEntries++;
      else if (state === 'changed') changedEntries++;

      unseenEntries.push(`${path}:${state}`);
    }

    return {
      stateEntries,
      ignoredEntries,
      signatureEntries,
      newEntries,
      changedEntries,
      unseenHash: this.hashString(unseenEntries.sort().join('\n')),
      ignoredHash: this.hashString(Object.keys(data?.ignoredByPath || {}).sort().join('\n')),
      signatureKeyHash: this.hashString(Object.keys(data?.seenSignatureByPath || {}).sort().join('\n'))
    };
  }

  getFastMarkdownSignature(file) {
    if (!this.isMarkdownFile(file)) return null;
    return `mdm:${file.stat?.size || 0}:${file.stat?.mtime || 0}`;
  }

  parseFastMarkdownSignature(signature) {
    if (typeof signature !== 'string' || !signature.startsWith('mdm:')) return null;

    const [, sizePart, mtimePart] = signature.split(':');
    const size = Number(sizePart);
    const mtime = Number(mtimePart);

    if (!Number.isFinite(size) || !Number.isFinite(mtime)) return null;
    return { size, mtime };
  }

  async getBaselineSignature(file) {
    if (!this.isTrackableFile(file)) return null;

    if (this.isMarkdownFile(file) && this.settings.fastStartupBaseline) {
      return this.getFastMarkdownSignature(file);
    }

    return this.getCurrentSignature(file);
  }

  async matchesSeenSignature(file, seenSignature) {
    if (!this.isTrackableFile(file) || !seenSignature) return false;

    if (!this.isMarkdownFile(file)) {
      return seenSignature === this.getFileSignature(file);
    }

    const fastSignature = this.getFastMarkdownSignature(file);
    if (seenSignature === fastSignature) return true;

    const parsedFast = this.parseFastMarkdownSignature(seenSignature);
    if (parsedFast) {
      const currentSize = Number(file.stat?.size || 0);
      const currentMtime = Number(file.stat?.mtime || 0);

      if (parsedFast.size === currentSize && Math.abs(parsedFast.mtime - currentMtime) <= 1000) {
        return true;
      }
    }

    const currentSignature = await this.getCurrentSignature(file);
    return currentSignature === seenSignature;
  }

  async savePluginData(options = {}) {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    this._isSaving = true;

    try {
      const now = Date.now();

      if (!options.forceOverwriteSyncFile) {
        const diskData = await this.readSyncFile();

        if (diskData) {
          this.data = this.mergeStates(this.data, diskData);
        }
      }

      for (const path of options.deletedPaths || []) {
        if (!path) continue;
        this.deletePathState(path);
        delete this.data.ignoredByPath[path];
        delete this.data.seenSignatureByPath[path];
      }

      this.data.updatedAt = now;
      this.rebuildLegacyRuntimeMaps(this.data);

      await this.writeSyncFile(this.data);
    } finally {
      this._isSaving = false;
    }
  }

  async persistPluginDataSnapshot() {
    this.rebuildLegacyRuntimeMaps(this.data);
    await this.writeSyncFile(this.data);
  }

  queuePluginDataSave(delay = 250) {
    if (this._saveTimer) clearTimeout(this._saveTimer);

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.savePluginData();
    }, delay);
  }

  getFileSignature(file) {
    if (!this.isTrackableFile(file)) return null;
    return `${file.extension || ''}:${file.stat?.size || 0}:${file.stat?.mtime || 0}`;
  }

  async getCurrentSignature(file) {
    if (!this.isTrackableFile(file)) return null;

    if (!this.isMarkdownFile(file)) {
      return this.getFileSignature(file);
    }

    try {
      const text = await this.app.vault.cachedRead(file);
      return `md:${file.stat?.size || 0}:${this.hashString(text)}`;
    } catch (error) {
      console.warn(`Unseen Changes Dot: could not hash ${file.path}`, error);
      return this.getFileSignature(file);
    }
  }

  hashString(value) {
    let hash = 2166136261;

    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36);
  }

  async initializeSeenSignatures() {
    const changed = await this.populateMissingSeenSignatures();
    if (!changed && this.data.signaturesInitialized) {
      await this.persistPluginDataSnapshot();
      return false;
    }

    await this.persistPluginDataSnapshot();
    return changed;
  }

  isMarkdownFile(file) {
    return file instanceof obsidian.TFile && file.extension === 'md';
  }

  isTrackableFile(file) {
    if (!(file instanceof obsidian.TFile)) return false;
    if (this.isPluginStatePath(file.path)) return false;
    if (this.isMarkdownFile(file)) return true;
    return Boolean(this.settings.trackAttachments);
  }

  isPluginStatePath(path) {
    return path === this.syncFilePath
      || path === this.legacySyncFilePath
      || path?.startsWith(`${this.seenPulseDir}/`);
  }

  isUnseen(file) {
    return this.getRawUnseenState(file) !== null;
  }

  getRawUnseenState(file) {
    if (!this.isTrackableFile(file)) return null;
    if (this.isIgnoredFile(file)) return null;
    if (this.isFileActive(file)) return null;

    const state = this.getPathState(file.path);
    return state === 'new' || state === 'changed' ? state : null;
  }

  getUnseenState(file) {
    const state = this.getRawUnseenState(file);
    return this.isVisibleState(state) ? state : null;
  }

  isVisibleState(state) {
    if (state !== 'new' && state !== 'changed') return false;
    if (this.settings.dotDisplayMode === 'both') return true;
    return this.settings.dotDisplayMode === state;
  }

  getVisibleStates(states) {
    return Array.from(new Set((states || []).filter((state) => this.isVisibleState(state))));
  }

  getStateColor(state) {
    return state === 'new'
      ? this.settings.newColor
      : this.settings.changedColor;
  }

  getStateShape(state) {
    return state === 'new'
      ? this.settings.newShape
      : this.settings.changedShape;
  }

  markFileUnseen(file, state) {
    if (!this.isTrackableFile(file)) return;
    if (this.isIgnoredFile(file)) return;

    if (this.isFileActive(file)) {
      this._manualUnseenPaths.add(file.path);
    }

    this.setUnseenState(file, state);
    this.refreshPathAndAncestors(file.path);
    this.refreshTabDots();
    this.queuePluginDataSave();
  }

  async markFileSeen(file, options = {}) {
    if (!this.isTrackableFile(file)) return;
    if (!options.overrideStartupDelay && this.shouldDelayStartupUnreadSeen(file)) return;

    const path = file.path;
    this._manualUnseenPaths.delete(path);

    if (this.startupUnseenPaths?.has(path)) {
      this.startupUnseenPaths.delete(path);
    }

    const wasUnseen = this.getPathState(path) === 'new' || this.getPathState(path) === 'changed';
    const previousEntry = this.data.stateByPath?.[path] || {};
    const previousSignature = this.data.seenSignatureByPath[path];
    const signature = wasUnseen || !this.settings.fastStartupBaseline
      ? await this.getCurrentSignature(file)
      : await this.getBaselineSignature(file);
    const signatureChanged = previousSignature !== signature;
    this.data.seenSignatureByPath[path] = signature;

    const stateChanged = this.setPathState(path, 'seen', {
      tombstone: Boolean(options.publishSeen || wasUnseen || previousEntry.tombstone),
      now: wasUnseen ? Date.now() : Number(previousEntry.seenAt || Date.now()),
      changedAt: Number(previousEntry.changedAt || 0)
    });

    if (wasUnseen || stateChanged) {
      this.invalidateFolderMap();
      this.refreshPathAndAncestors(path);
      this.refreshTabDots();
    }

    if (options.publishSeen || wasUnseen) {
      await this.writeSeenPulse(path);
    }

    if (wasUnseen || stateChanged) {
      await this.savePluginData();
      return;
    }

    if (signatureChanged) {
      await this.persistPluginDataSnapshot();
    }
  }

  clearUnseenState(path) {
    const wasUnseen = this.data.unseenByPath?.[path] !== undefined;
    this.setPathState(path, 'seen', { tombstone: wasUnseen });
    return wasUnseen;
  }

  setUnseenState(file, state) {
    if (!this.isTrackableFile(file)) return false;

    const current = this.getPathState(file.path);
    const newState = current === 'new' ? 'new' : state;

    if (newState !== 'new' && newState !== 'changed') return false;

    return this.setPathState(file.path, newState);
  }

  showUnseenNow(file, state) {
    if (!this.isTrackableFile(file)) return;

    this.setUnseenState(file, state);
    this.refreshPathAndAncestors(file.path);
    this.refreshTabDots();
    this.schedulePathRefreshes(file.path);
    this.queuePluginDataSave();
  }

  isStartupExistingFile(file) {
    return this.isTrackableFile(file) && this.startupPaths.has(file.path);
  }

  shouldSuppressStartupExistingFileEvent(file) {
    return this.isStartupExistingFile(file)
      && Date.now() < this.ignoreExistingFileEventsUntil;
  }

  isPersistedUnseenPath(path) {
    const state = this.getPathState(path);
    return state === 'new' || state === 'changed';
  }

  async handleStartupExistingFileEvent(file) {
    if (!this.shouldSuppressStartupExistingFileEvent(file)) return false;

    this.knownPaths.add(file.path);

    if (this.isPersistedUnseenPath(file.path)) {
      return true;
    }

    await this.captureStartupSeenState(file);
    return true;
  }

  async captureStartupSeenState(file) {
    if (!this.isTrackableFile(file)) return false;

    this.knownPaths.add(file.path);

    let changed = false;
    const signature = await this.getBaselineSignature(file);

    if (signature && this.data.seenSignatureByPath[file.path] !== signature) {
      this.data.seenSignatureByPath[file.path] = signature;
      changed = true;
    }

    if (this.setPathState(file.path, 'seen')) {
      changed = true;
    }

    if (changed) {
      this.queuePluginDataSave(1000);
    }

    return changed;
  }

  shouldDelayStartupUnreadSeen(file) {
    return this.isTrackableFile(file)
      && this.startupUnseenPaths?.has(file.path)
      && Date.now() < this.preserveStartupUnseenUntil;
  }

  async onFileCreated(file) {
    if (!this._storageReady) return;
    if (!this.isTrackableFile(file)) return;

    if (this.startupPaths.has(file.path) || Date.now() < this.ignoreCreateEventsUntil) {
      if (this.getPathState(file.path) !== 'new' && this.getPathState(file.path) !== 'changed') {
        await this.captureStartupSeenState(file);
      } else {
        this.knownPaths.add(file.path);
      }

      return;
    }

    const mayBeIgnored = Boolean(this.data.ignoredByPath[file.path]) || this.metadataHasTaskMarker(file);

    if ((mayBeIgnored && await this.updateIgnoredState(file)) || this.isFileActive(file)) {
      this.knownPaths.add(file.path);
      await this.markFileSeen(file);
      return;
    }

    this.knownPaths.add(file.path);
    this.showUnseenNow(file, 'new');

    if (this.isMarkdownFile(file)) {
      this.scheduleIgnoredInspection(file);
    }
  }

  async onFileModified(file) {
    if (!this._storageReady) return;
    if (this.isPluginStatePath(file.path)) {
      await this.importSyncFileState();
      return;
    }

    if (await this.handleStartupExistingFileEvent(file)) return;

    if (!this.isMarkdownFile(file)) {
      await this.onAttachmentModified(file);
      return;
    }

    const mayBeIgnored = Boolean(this.data.ignoredByPath[file.path]) || this.metadataHasTaskMarker(file);

    const seenSignature = this.data.seenSignatureByPath[file.path];
    const currentState = this.getPathState(file.path);

    if (currentState !== 'new' && currentState !== 'changed' && await this.matchesSeenSignature(file, seenSignature)) {
      return;
    }

    if ((mayBeIgnored && await this.updateIgnoredState(file)) || (this.isFileActive(file) && Date.now() >= this.ignoreSeenUntil)) {
      await this.markFileSeen(file);
      return;
    }

    this.showUnseenNow(file, 'changed');
    this.scheduleIgnoredInspection(file);
  }

  async onAttachmentModified(file) {
    if (!this._storageReady) return;
    if (!this.isTrackableFile(file)) return;

    if (await this.handleStartupExistingFileEvent(file)) return;

    if (this.knownPaths.has(file.path)) {
      const seenSignature = this.data.seenSignatureByPath[file.path];
      const currentState = this.getPathState(file.path);

      if (currentState !== 'new' && currentState !== 'changed' && await this.matchesSeenSignature(file, seenSignature)) {
        return;
      }

      if (this.isFileActive(file) && Date.now() >= this.ignoreSeenUntil) {
        await this.markFileSeen(file);
        return;
      }

      this.showUnseenNow(file, 'changed');
      return;
    }

    if (this.startupPaths.has(file.path) || Date.now() < this.ignoreCreateEventsUntil) {
      await this.captureStartupSeenState(file);
      return;
    }

    this.knownPaths.add(file.path);
    this.showUnseenNow(file, 'new');
  }

  async onFileDeleted(file) {
    if (!this._storageReady) return;
    if (!file?.path) {
      this.scheduleRefresh();
      return;
    }

    if (this.startupUnseenPaths?.has(file.path)) {
      this.startupUnseenPaths.delete(file.path);
    }

    this.deletePathState(file.path);
    delete this.data.ignoredByPath[file.path];
    delete this.data.seenSignatureByPath[file.path];

    this.knownPaths.delete(file.path);
    this._manualUnseenPaths.delete(file.path);

    await this.savePluginData({ deletedPaths: [file.path] });
    this.scheduleRefresh();
    this.refreshTabDots();
  }

  async onFileRenamed(file, oldPath) {
    if (!this._storageReady) return;
    if (oldPath) this.knownPaths.delete(oldPath);
    if (file?.path) this.knownPaths.add(file.path);

    if (oldPath && this.startupUnseenPaths?.has(oldPath)) {
      this.startupUnseenPaths.delete(oldPath);
      if (file?.path) this.startupUnseenPaths.add(file.path);
    }

    if (oldPath && file?.path && this.data.stateByPath?.[oldPath] !== undefined) {
      this.data.stateByPath[file.path] = this.data.stateByPath[oldPath];
      delete this.data.stateByPath[oldPath];
    }

    if (oldPath && file?.path && this.data.ignoredByPath[oldPath] !== undefined) {
      this.data.ignoredByPath[file.path] = this.data.ignoredByPath[oldPath];
      delete this.data.ignoredByPath[oldPath];
    }

    if (oldPath && file?.path && this.data.seenSignatureByPath[oldPath] !== undefined) {
      this.data.seenSignatureByPath[file.path] = this.data.seenSignatureByPath[oldPath];
      delete this.data.seenSignatureByPath[oldPath];
    }

    if (oldPath && this._manualUnseenPaths.has(oldPath)) {
      this._manualUnseenPaths.delete(oldPath);
      if (file?.path) this._manualUnseenPaths.add(file.path);
    }

    this.rebuildLegacyRuntimeMaps(this.data);

    await this.savePluginData({ deletedPaths: oldPath ? [oldPath] : [] });
    this.scheduleRefresh();
    this.refreshTabDots();

    if (file?.path) {
      this.schedulePathRefreshes(file.path);
    }
  }

  schedulePathRefreshes(path) {
    const oldTimers = this._pathRefreshTimers.get(path) || [];

    for (const oldTimer of oldTimers) clearTimeout(oldTimer);

    const timers = [];
    const times = [0, 16, 50, 120, 250, 500, 1000, 2000];

    for (const time of times) {
      const timer = setTimeout(() => {
        this.refreshPathAndAncestors(path);
        this.refreshTabDots();

        if (time === times[times.length - 1]) {
          this._pathRefreshTimers.delete(path);
        }
      }, time);

      timers.push(timer);
    }

    this._pathRefreshTimers.set(path, timers);
  }

  refreshPathAndAncestors(path) {
    this.refreshDotForPath(path);
    this._refreshAncestorPaths(path);
  }

  _refreshAncestorPaths(path) {
    const parts = path.split('/');

    for (let i = parts.length - 2; i >= 0; i--) {
      this.refreshDotForPath(parts.slice(0, i + 1).join('/'));
    }

    this.refreshDotForPath('/');
  }

  scheduleActiveSeenPublishes() {
    const file = this.getFrontFile();
    if (!this.isTrackableFile(file)) return;

    this.scheduleFileSeenPublishes(file);
  }

  releaseManualUnseenHolds(activePath = this.getFrontFile()?.path || null) {
    for (const path of this._manualUnseenPaths) {
      if (path !== activePath) this._manualUnseenPaths.delete(path);
    }
  }

  scheduleFileSeenPublishes(file) {
    if (!this.isTrackableFile(file)) return;

    const oldTimers = this._activeSeenTimers.get(file.path) || [];

    for (const id of oldTimers) {
      clearTimeout(id);
    }

    const timers = [];
    const times = [0, 120, 500, 1200, 2500];

    for (const time of times) {
      const id = setTimeout(() => {
        const activeFile = this.getFrontFile();

        if (activeFile?.path !== file.path) {
          if (time === times[times.length - 1]) {
            this._activeSeenTimers.delete(file.path);
          }
          return;
        }

        this.markActiveFileSeen(activeFile, { force: time > 0, publishSeen: true })
          .catch((error) => console.warn('Unseen Changes Dot: could not publish active seen state', error));

        if (time === times[times.length - 1]) {
          this._activeSeenTimers.delete(file.path);
        }
      }, time);

      timers.push(id);
    }

    this._activeSeenTimers.set(file.path, timers);
  }

  async markActiveFileSeen(file = null, options = {}) {
    if (!this._storageReady) return;
    if (Date.now() < this.ignoreSeenUntil && !options.force) return;

    const targetFile = this.isTrackableFile(file) ? file : this.getFrontFile();
    if (!this.isTrackableFile(targetFile)) return;
    if (this.shouldDelayStartupUnreadSeen(targetFile)) return;
    if (this._manualUnseenPaths.has(targetFile.path)) return;

    const state = this.getPathState(targetFile.path);
    const isUnseenState = state === 'new' || state === 'changed';
    const entry = this.data.stateByPath?.[targetFile.path];
    const canRepublishSeen = Boolean(options.publishSeen && entry?.state === 'seen' && entry?.tombstone);

    if (!isUnseenState && !canRepublishSeen) return;

    await this.markFileSeen(targetFile, { publishSeen: Boolean(options.publishSeen) });
  }

  isFileActive(file) {
    if (!this.isTrackableFile(file)) return false;

    const activeFile = this.getFrontFile();
    return activeFile?.path === file.path;
  }

  getFrontFile() {
    const activeWorkspaceFile = typeof this.app.workspace.getActiveFile === 'function'
      ? this.app.workspace.getActiveFile()
      : null;
    if (this.isTrackableFile(activeWorkspaceFile)) return activeWorkspaceFile;

    const activeLeafFile = this.app.workspace.activeLeaf?.view?.file;
    if (this.isTrackableFile(activeLeafFile)) return activeLeafFile;

    return null;
  }

  isIgnoredFile(file) {
    if (!this.isTrackableFile(file)) return false;
    if (!this.isMarkdownFile(file)) return false;

    return Boolean(this.data.ignoredByPath[file.path]) || this.metadataHasTaskMarker(file);
  }

  async updateIgnoredState(file) {
    if (!this.isMarkdownFile(file)) return false;

    const wasIgnored = Boolean(this.data.ignoredByPath[file.path]);
    const hadUnseen = this.getPathState(file.path) === 'new' || this.getPathState(file.path) === 'changed';
    const oldSignature = this.data.seenSignatureByPath[file.path];

    let ignored = this.metadataHasTaskMarker(file);

    try {
      const text = await this.app.vault.cachedRead(file);
      ignored = ignored || this.contentHasTaskMarker(text);
    } catch (error) {
      console.warn(`Unseen Changes Dot: could not inspect ${file.path}`, error);
    }

    if (ignored) {
      this.data.ignoredByPath[file.path] = true;
      this.data.seenSignatureByPath[file.path] = await this.getCurrentSignature(file);
      this.setPathState(file.path, 'seen');
    } else {
      delete this.data.ignoredByPath[file.path];
    }

    const changed = wasIgnored !== ignored
      || (ignored && hadUnseen)
      || (ignored && oldSignature !== this.data.seenSignatureByPath[file.path]);

    if (changed) {
      this.invalidateFolderMap();
      this.queuePluginDataSave();
    }

    return ignored;
  }

  scheduleIgnoredInspection(file, delay = 300) {
    if (!this.isMarkdownFile(file)) return;

    const oldTimer = this._ignoredInspectionTimers.get(file.path);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(async () => {
      this._ignoredInspectionTimers.delete(file.path);

      const currentFile = this.app.vault.getAbstractFileByPath(file.path);
      if (!this.isMarkdownFile(currentFile)) return;

      const ignored = await this.updateIgnoredState(currentFile);
      if (!ignored) return;

      this.refreshPathAndAncestors(currentFile.path);
      this.refreshTabDots();
    }, delay);

    this._ignoredInspectionTimers.set(file.path, timer);
  }

  metadataHasTaskMarker(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const inlineTags = cache?.tags || [];

    if (inlineTags.some((entry) => this.isTaskValue(entry.tag))) return true;

    const frontmatter = cache?.frontmatter || {};

    for (const key of ['tags', 'tag', 'hashtags', 'hashtag', 'type', 'kind', 'task', 'tasks']) {
      if (!(key in frontmatter)) continue;

      if (key === 'task' || key === 'tasks') {
        return frontmatter[key] !== false;
      }

      if (this.isTaskPropertyValue(frontmatter[key])) return true;
    }

    return false;
  }

  contentHasTaskMarker(text) {
    if (!text) return false;
    return this.frontmatterHasTaskMarker(text) || this.bodyHasTaskHashtag(text);
  }

  frontmatterHasTaskMarker(text) {
    if (!text.startsWith('---')) return false;

    const end = text.indexOf('\n---', 3);
    if (end === -1) return false;

    const frontmatter = text.slice(3, end);
    const relevantKeys = new Set(['tag', 'tags', 'hashtag', 'hashtags', 'type', 'kind', 'task', 'tasks']);
    let readingRelevantList = false;

    for (const rawLine of frontmatter.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const keyMatch = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);

      if (keyMatch) {
        const key = keyMatch[1].toLowerCase();
        const value = keyMatch[2] || '';

        if (key === 'task' || key === 'tasks') {
          return !/^(false|no|0|null)?$/i.test(value.trim());
        }

        readingRelevantList = relevantKeys.has(key) && value.trim() === '';

        if (relevantKeys.has(key) && this.isTaskPropertyValue(value)) {
          return true;
        }

        continue;
      }

      if (readingRelevantList) {
        const itemMatch = rawLine.match(/^\s*-\s*(.*)$/);

        if (itemMatch && this.isTaskPropertyValue(itemMatch[1])) return true;
        if (!itemMatch && !/^\s+/.test(rawLine)) readingRelevantList = false;
      }
    }

    return false;
  }

  bodyHasTaskHashtag(text) {
    return /(^|[\s([{])#tasks?(?:\/[^\s\])}.,;:]*)?(?=$|[\s\])}.,;:])/i.test(text);
  }

  isTaskPropertyValue(value) {
    if (Array.isArray(value)) return value.some((item) => this.isTaskValue(item));
    if (this.isTaskValue(value)) return true;

    return String(value || '')
      .replace(/[\[\]{}]/g, ' ')
      .split(/[,\s]+/)
      .some((item) => this.isTaskValue(item));
  }

  isTaskValue(value) {
    const normalized = String(value || '')
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase();

    return normalized === '#task'
      || normalized === '#tasks'
      || normalized === 'task'
      || normalized === 'tasks'
      || normalized.startsWith('#task/')
      || normalized.startsWith('#tasks/')
      || normalized.startsWith('task/')
      || normalized.startsWith('tasks/');
  }

  getFileExplorer() {
    const leaves = this.app.workspace.getLeavesOfType('file-explorer');
    if (leaves.length === 0) return null;

    return leaves[0].view;
  }

  installExplorerObserver() {
    if (this._explorerObserver) {
      this._explorerObserver.disconnect();
      this._explorerObserver = null;
    }

    const explorer = this.getFileExplorer();
    const root = explorer?.containerEl;

    if (!root || typeof MutationObserver === 'undefined') return;

    this._explorerObserver = new MutationObserver((mutations) => {
      const shouldRefresh = mutations.some((mutation) => {
        if (mutation.type === 'attributes') {
          const target = mutation.target;

          if (target.nodeType !== Node.ELEMENT_NODE) return false;
          if (target.classList?.contains('unread-dot-target')) return false;
          if (target.classList?.contains('unread-dot-stack')) return false;
          if (target.classList?.contains('unread-dot')) return false;

          return target.classList?.contains('tree-item')
            || target.classList?.contains('nav-folder')
            || target.classList?.contains('nav-file')
            || target.getAttribute?.('aria-expanded') !== null;
        }

        const nodes = [...Array.from(mutation.addedNodes || []), ...Array.from(mutation.removedNodes || [])];

        if (nodes.length === 0) return false;

        return nodes.some((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return false;
          if (node.classList?.contains('unread-dot-stack')) return false;
          if (node.classList?.contains('unread-dot')) return false;
          if (node.querySelector?.('.unread-dot')) return false;
          return true;
        });
      });

      if (shouldRefresh) this.scheduleRefresh();
    });

    this._explorerObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-expanded']
    });
  }

  getDotTarget(itemEl) {
    return itemEl.querySelector('.nav-file-title-content')
      || itemEl.querySelector('.nav-folder-title-content')
      || itemEl.querySelector('.tree-item-inner')
      || itemEl;
  }

  removeDotsFromTarget(target, extraClass = null) {
    if (!target) return;

    for (const child of Array.from(target.children || [])) {
      if (child.classList?.contains('unread-dot-stack')) {
        if (extraClass && !child.querySelector(`.${extraClass}`)) continue;
        child.remove();
        continue;
      }

      if (child.classList?.contains('unread-dot')) {
        if (extraClass && !child.classList.contains(extraClass)) continue;
        child.remove();
      }
    }

    this.cleanupDotTarget(target);
  }

  cleanupDotTarget(target) {
    if (!target) return;

    if (target.querySelector('.unread-dot-stack, .unread-dot')) return;
    target.classList.remove('unread-dot-target', 'unread-dot-tab-target', 'unread-dot-explorer-target');
    target.style.removeProperty('--unread-dot-offset');
    target.style.removeProperty('--unread-dot-stack-width');
  }

  applyDotAppearance(dot, kind) {
    if (!dot || (kind !== 'new' && kind !== 'changed')) return;

    const shape = this.getStateShape(kind);
    const color = this.getStateColor(kind);

    for (const candidate of DOT_SHAPES) {
      dot.classList.remove(`unread-dot-shape-${candidate}`);
    }

    dot.classList.add(`unread-dot-shape-${shape}`);
    dot.style.backgroundColor = color;
  }

  getTrackableFilesInFolder(folder) {
    const files = [];

    for (const child of folder.children) {
      if (this.isTrackableFile(child)) {
        files.push(child);
      } else if (child instanceof obsidian.TFolder) {
        files.push(...this.getTrackableFilesInFolder(child));
      }
    }

    return files;
  }

  getUnseenFilesInFolder(folder) {
    const unseen = [];
    const isRoot = folder.path === '/';
    const folderPrefix = isRoot ? '' : folder.path + '/';

    for (const path of Object.keys(this.data.unseenByPath || {})) {
      if (isRoot || path.startsWith(folderPrefix)) {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (this.isTrackableFile(file) && this.isUnseen(file)) {
          unseen.push(file);
        }
      }
    }

    return unseen;
  }

  invalidateFolderMap() {
    this._cachedFolderMap = null;
    this._cachedFolderMapKey = null;
  }

  getFolderMapCacheKey() {
    return [
      this.getFrontFile()?.path || '',
      this.settings.dotDisplayMode,
      this.settings.trackAttachments ? 'attachments:on' : 'attachments:off'
    ].join('::');
  }

  getFolderStatesMap() {
    const cacheKey = this.getFolderMapCacheKey();
    if (this._cachedFolderMap && this._cachedFolderMapKey === cacheKey) return this._cachedFolderMap;

    const map = new Map();
    const activeFile = this.getFrontFile();

    for (const [path, state] of Object.entries(this.data.unseenByPath || {})) {
      if (state !== 'new' && state !== 'changed') continue;
      if (!this.isVisibleState(state)) continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!this.isTrackableFile(file) || this.isIgnoredFile(file)) continue;
      if (activeFile && activeFile.path === path) continue;

      if (!map.has('/')) map.set('/', new Set());
      map.get('/').add(state);

      const parts = path.split('/');

      for (let i = 0; i < parts.length - 1; i++) {
        const folderPath = parts.slice(0, i + 1).join('/');

        if (!map.has(folderPath)) map.set(folderPath, new Set());
        map.get(folderPath).add(state);
      }
    }

    this._cachedFolderMap = map;
    this._cachedFolderMapKey = cacheKey;
    return map;
  }

  folderUnseenStates(folder) {
    const map = this.getFolderStatesMap();
    const states = map.get(folder.path === '/' ? '/' : folder.path);
    return states ? Array.from(states) : [];
  }

  folderHasUnseen(folder) {
    return this.folderUnseenStates(folder).length > 0;
  }

  refreshAllDots() {
    const explorer = this.getFileExplorer();

    if (explorer && explorer.fileItems) {
      for (const path in explorer.fileItems) {
        if (!Object.prototype.hasOwnProperty.call(explorer.fileItems, path)) continue;
        this.refreshDotForPath(path, false);
      }
    }

    this.refreshTabDots();
  }

  scheduleRefresh() {
    if (this._refreshScheduled) return;

    this._refreshScheduled = true;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._refreshScheduled = false;
      this.refreshAllDots();
    }, 16);
  }

  scheduleExplorerRefreshBurst() {
    for (const id of this._explorerRefreshBurstTimers) {
      clearTimeout(id);
    }

    this._explorerRefreshBurstTimers = [];

    for (const delay of [120, 500, 1200, 2500, 5000]) {
      const id = setTimeout(() => {
        this.installExplorerObserver();
        this.refreshAllDots();
      }, delay);

      this._explorerRefreshBurstTimers.push(id);
    }
  }

  refreshFolderDots() {
    this.scheduleRefresh();
  }

  scheduleResumeSyncRefresh(delay = 120) {
    if (this._resumeRefreshTimer) {
      clearTimeout(this._resumeRefreshTimer);
    }

    this._resumeRefreshTimer = setTimeout(() => {
      this._resumeRefreshTimer = null;
      this.installExplorerObserver();
      this.scheduleExplorerRefreshBurst();
      this.scheduleRefresh();

      this.importSyncFileState()
        .catch((error) => console.warn('Unseen Changes Dot: could not refresh sync after resume', error));
    }, delay);
  }

  refreshDotForPath(path, includeFolders = true) {
    const explorer = this.getFileExplorer();
    if (!explorer || !explorer.fileItems) return;

    const item = explorer.fileItems[path];
    if (!item?.selfEl) return;

    this.removeDotsFromTarget(item.selfEl);
    this.removeDotsFromTarget(this.getDotTarget(item.selfEl));

    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    if (!abstractFile && path !== '/') return;

    if (abstractFile && this.isTrackableFile(abstractFile)) {
      const state = this.getPathState(path);
      const activeFile = this.getFrontFile();

      if (this.isVisibleState(state) && (!activeFile || activeFile.path !== path)) {
        this.addDot(item.selfEl, [state]);
      }

      return;
    }

    if (includeFolders || (abstractFile && abstractFile instanceof obsidian.TFolder) || path === '/') {
      const folderRef = abstractFile || { path: '/' };
      const states = this.getVisibleStates(this.folderUnseenStates(folderRef));

      if (states.length > 0) {
        this.addDot(item.selfEl, states);
      }
    }
  }

  addDot(itemEl, kinds) {
    const target = this.getDotTarget(itemEl);

    this.removeDotsFromTarget(target);
    target.classList.add('unread-dot-target', 'unread-dot-explorer-target');

    const sortedKinds = Array.isArray(kinds) ? kinds.sort().reverse() : [kinds];
    const stackWidthPx = sortedKinds.reduce((total, kind, index) => {
      const dotWidth = kind === 'folder' ? 6 : 7;
      return total + dotWidth + (index > 0 ? 4 : 0);
    }, 0);

    target.style.setProperty('--unread-dot-stack-width', `${stackWidthPx}px`);
    target.style.setProperty('--unread-dot-offset', `${stackWidthPx + 6}px`);

    const stack = document.createElement('span');
    stack.classList.add('unread-dot-stack');

    for (const kind of sortedKinds) {
      const dot = document.createElement('span');
      dot.classList.add('unread-dot');

      if (kind === 'folder') {
        dot.classList.add('unread-dot-folder');
        dot.setAttribute('aria-label', 'Folder contains unseen notes');
      } else {
        dot.classList.add('unread-dot-file');
        dot.classList.add(kind === 'new' ? 'unread-dot-new' : 'unread-dot-changed');
        this.applyDotAppearance(dot, kind);
        dot.setAttribute('aria-label', kind === 'new' ? 'Contains new unseen notes' : 'Contains changed unseen notes');
      }

      stack.appendChild(dot);
    }

    target.insertBefore(stack, target.firstChild || null);
  }

  refreshTabDots() {
    document.querySelectorAll('.unread-dot-tab').forEach((el) => {
      const target = el.parentElement;
      el.remove();
      this.cleanupDotTarget(target);
    });

    const visitLeaf = (leaf) => {
      const file = leaf?.view?.file;
      if (!this.isTrackableFile(file)) return;

      const state = this.getUnseenState(file);
      if (!state) return;

      const target = this.getTabDotTarget(leaf);
      if (!target) return;

      this.addTabDot(target, state);
    };

    if (typeof this.app.workspace.iterateAllLeaves === 'function') {
      this.app.workspace.iterateAllLeaves(visitLeaf);
    } else {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        visitLeaf(leaf);
      }
    }
  }

  getTabDotTarget(leaf) {
    const header = leaf?.tabHeaderEl || leaf?.tabHeaderInnerEl?.parentElement;
    if (!header) return null;

    return header.querySelector('.workspace-tab-header-inner-title')
      || header.querySelector('.workspace-tab-header-inner')
      || header;
  }

  addTabDot(target, kind) {
    this.removeDotsFromTarget(target, 'unread-dot-tab');
    target.classList.add('unread-dot-target', 'unread-dot-tab-target');

    const dot = document.createElement('span');
    dot.classList.add('unread-dot', 'unread-dot-tab');
    dot.classList.add(kind === 'new' ? 'unread-dot-new' : 'unread-dot-changed');
    this.applyDotAppearance(dot, kind);
    dot.setAttribute('aria-label', kind === 'new' ? 'New item not seen yet' : 'Changed note not seen yet');

    target.insertBefore(dot, target.firstChild);
  }
}

class UnseenChangesDotSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async saveSetting(key, value) {
    const previousSettings = { ...this.plugin.settings };
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings(previousSettings);
    this.display();
  }

  addColorTextSetting(containerEl, config) {
    const setting = new obsidian.Setting(containerEl)
      .setName(config.name)
      .setDesc(config.desc)
      .addText((text) => {
        text
          .setPlaceholder(config.placeholder)
          .setValue(this.plugin.settings[config.key]);

        text.inputEl.addEventListener('change', async () => {
          const nextValue = text.inputEl.value.trim() || DEFAULT_SETTINGS[config.key];
          await this.saveSetting(config.key, nextValue);
        });
      });

    setting.addExtraButton((button) => {
      button
        .setIcon('rotate-ccw')
        .setTooltip('Reset to default')
        .onClick(async () => {
          await this.saveSetting(config.key, DEFAULT_SETTINGS[config.key]);
        });
    });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const syncNote = containerEl.createDiv({ cls: 'setting-item-description' });
    syncNote.setText('Cross-device dots depend on how quickly your sync service propagates plugin data in the vault config folder. Delays or conflicts there can make Mac and iPad states converge more slowly.');
    syncNote.style.marginBottom = '1rem';

    new obsidian.Setting(containerEl)
      .setName('Behavior')
      .setHeading();

    new obsidian.Setting(containerEl)
      .setName('Shown states')
      .setDesc('Choose whether dots show unread/new notes, changed notes, or both.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('both', 'Unread/new and changed')
          .addOption('new', 'Only unread/new')
          .addOption('changed', 'Only changed')
          .setValue(this.plugin.settings.dotDisplayMode)
          .onChange(async (value) => {
            await this.saveSetting('dotDisplayMode', value);
          });
      });

    new obsidian.Setting(containerEl)
      .setName('Track attachments')
      .setDesc('Include non-markdown files in unseen tracking. Leaving this off is lighter and usually better for large vaults.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.trackAttachments)
          .onChange(async (value) => {
            await this.saveSetting('trackAttachments', value);
          });
      });

    new obsidian.Setting(containerEl)
      .setName('Sync polling interval')
      .setDesc('How often the plugin checks synced runtime state. Slower polling reduces background work.')
      .addDropdown((dropdown) => {
        for (const option of SYNC_POLLING_OPTIONS) {
          const label = option >= 1000
            ? `${option / 1000}s`
            : `${option}ms`;
          dropdown.addOption(String(option), label);
        }

        dropdown
          .setValue(String(this.plugin.settings.syncPollingMs))
          .onChange(async (value) => {
            await this.saveSetting('syncPollingMs', Number(value) || DEFAULT_SETTINGS.syncPollingMs);
          });
      });

    new obsidian.Setting(containerEl)
      .setName('Fast startup baseline')
      .setDesc('Prefer metadata signatures for startup, pulse imports, and already-seen files. This keeps large vaults noticeably lighter.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.fastStartupBaseline)
          .onChange(async (value) => {
            await this.saveSetting('fastStartupBaseline', value);
          });
      });

    new obsidian.Setting(containerEl)
      .setName('Appearance')
      .setHeading();

    new obsidian.Setting(containerEl)
      .setName('Unread/new shape')
      .setDesc('Shape used for unread or newly created notes.')
      .addDropdown((dropdown) => {
        for (const shape of DOT_SHAPES) {
          dropdown.addOption(shape, shape.charAt(0).toUpperCase() + shape.slice(1));
        }

        dropdown
          .setValue(this.plugin.settings.newShape)
          .onChange(async (value) => {
            await this.saveSetting('newShape', value);
          });
      });

    new obsidian.Setting(containerEl)
      .setName('Changed shape')
      .setDesc('Shape used for changed notes.')
      .addDropdown((dropdown) => {
        for (const shape of DOT_SHAPES) {
          dropdown.addOption(shape, shape.charAt(0).toUpperCase() + shape.slice(1));
        }

        dropdown
          .setValue(this.plugin.settings.changedShape)
          .onChange(async (value) => {
            await this.saveSetting('changedShape', value);
          });
      });

    this.addColorTextSetting(containerEl, {
      key: 'newColor',
      name: 'Unread/new color',
      desc: 'Any CSS color value. Example: #74B3F5.',
      placeholder: '#74B3F5'
    });

    this.addColorTextSetting(containerEl, {
      key: 'changedColor',
      name: 'Changed color',
      desc: 'Any CSS color value. Example: var(--interactive-accent) or #F59E0B.',
      placeholder: 'var(--interactive-accent)'
    });
  }
}

module.exports = UnseenChangesDotPlugin;
