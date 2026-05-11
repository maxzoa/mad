const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const HISTORY_DIR = 'history';
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const HISTORY_IMAGES_DIR = path.join(HISTORY_DIR, 'images');
const HISTORY_BACKUPS_DIR = path.join(HISTORY_DIR, 'backups');
const DRAFT_FILE = path.join(HISTORY_DIR, 'draft.json');
const MENU_EXPORTS_DIR = 'saved-menus';
const SETTINGS_FILE = 'menu-settings.json';
const TEMPLATE_DIR = 'templates';
const TEMPLATE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const APP_VERSION = '2.0.1';
const UPDATE_SOURCE_FILE = 'update-source.json';
const DEFAULT_UPDATE_MANIFEST_URL = '';
const STABLE_LAUNCHER_NAME = 'Конструктор меню.exe';

const JSZip = require('jszip');

app.setName('Конструктор меню');
app.disableHardwareAcceleration();

function hasTemplates(dir) {
  const templatesDir = path.join(dir, TEMPLATE_DIR);
  if (!fsSync.existsSync(templatesDir)) return false;

  return fsSync.readdirSync(templatesDir, { withFileTypes: true })
    .some((entry) => entry.isFile() && isTemplateFile(entry.name));
}

function getAppFolder() {
  if (!app.isPackaged) {
    return __dirname;
  }

  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    process.cwd(),
    path.dirname(process.execPath),
    process.resourcesPath
  ].filter(Boolean);

  return candidates.find(hasTemplates) || candidates[0];
}

function isTemplateFile(fileName) {
  const lower = String(fileName || '').toLowerCase();
  return lower !== 'logo.png' && TEMPLATE_EXTENSIONS.has(path.extname(lower));
}

function displayNameFromFile(fileName) {
  return path.basename(fileName, path.extname(fileName))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function templateSortWeight(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('обыч')) return 0;
  if (lower.includes('день')) return 1;
  if (lower.includes('рецепт')) return 2;
  return 10;
}

async function ensureProductFolders() {
  await fs.mkdir(path.join(getAppFolder(), HISTORY_DIR), { recursive: true });
  await fs.mkdir(path.join(getAppFolder(), MENU_EXPORTS_DIR), { recursive: true });
}

async function readJson(fileName, fallback) {
  try {
    const raw = await fs.readFile(path.join(getAppFolder(), fileName), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(fileName, value) {
  const filePath = path.join(getAppFolder(), fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function safeFileName(name) {
  return String(name || 'menu_output.png')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'menu_output.png';
}

function getMimeFromDataUrl(dataUrl) {
  return String(dataUrl || '').match(/^data:([^;]+);base64,/)?.[1] || 'image/png';
}

function extensionForMime(mime) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  return '.png';
}

function makeEntryId(item, index) {
  return safeFileName(item.id || item.createdAt || `entry-${index}`);
}

async function fileToDataUrl(filePath) {
  const bytes = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg'
    : ext === '.webp'
      ? 'image/webp'
      : 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function normalizeHistoryForDisk(history) {
  const list = Array.isArray(history) ? history : [];

  return Promise.all(list.map(async (item, index) => {
    const entryId = makeEntryId(item || {}, index);
    const nextItem = {
      ...item,
      id: entryId,
      state: {}
    };

    for (const [blockName, block] of Object.entries(item?.state || {})) {
      const nextBlock = {
        kcal: block.kcal || '',
        text: block.text || ''
      };

      if (block.base64 && String(block.base64).startsWith('data:image/')) {
        const mime = getMimeFromDataUrl(block.base64);
        const imageFolder = path.join(getAppFolder(), HISTORY_IMAGES_DIR, entryId);
        await fs.mkdir(imageFolder, { recursive: true });
        const imageName = `${safeFileName(blockName)}${extensionForMime(mime)}`;
        const imagePath = path.join(imageFolder, imageName);
        const base64 = String(block.base64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
        await fs.writeFile(imagePath, Buffer.from(base64, 'base64'));
        nextBlock.imageFile = path.relative(path.join(getAppFolder(), HISTORY_DIR), imagePath).replace(/\\/g, '/');
      } else if (block.imageFile) {
        nextBlock.imageFile = block.imageFile;
      }

      nextItem.state[blockName] = nextBlock;
    }

    return nextItem;
  }));
}

async function normalizeDraftForDisk(draft) {
  if (!draft) return null;
  const normalized = await normalizeHistoryForDisk([{ ...draft, id: '__draft__' }]);
  return normalized[0] || null;
}

async function hydrateHistoryForUi(history) {
  const list = Array.isArray(history) ? history : [];

  return Promise.all(list.map(async (item) => {
    const nextItem = {
      ...item,
      state: {}
    };

    for (const [blockName, block] of Object.entries(item?.state || {})) {
      const nextBlock = { ...block };
      if (!nextBlock.base64 && nextBlock.imageFile) {
        const imagePath = path.join(getAppFolder(), HISTORY_DIR, nextBlock.imageFile);
        try {
          nextBlock.base64 = await fileToDataUrl(imagePath);
        } catch (_) {
          nextBlock.base64 = '';
        }
      }
      nextItem.state[blockName] = nextBlock;
    }

    return nextItem;
  }));
}

async function hydrateDraftForUi(draft) {
  if (!draft) return null;
  const hydrated = await hydrateHistoryForUi([draft]);
  return hydrated[0] || null;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createContextMenu(params) {
  const editFlags = params.editFlags || {};

  if (params.isEditable) {
    return Menu.buildFromTemplate([
      { label: 'Отменить', role: 'undo', enabled: editFlags.canUndo },
      { label: 'Повторить', role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { label: 'Вырезать', role: 'cut', enabled: editFlags.canCut },
      { label: 'Копировать', role: 'copy', enabled: editFlags.canCopy },
      { label: 'Вставить', role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { label: 'Выделить всё', role: 'selectAll', enabled: editFlags.canSelectAll }
    ]);
  }

  if (params.selectionText) {
    return Menu.buildFromTemplate([
      { label: 'Копировать', role: 'copy', enabled: editFlags.canCopy },
      { type: 'separator' },
      { label: 'Выделить всё', role: 'selectAll', enabled: editFlags.canSelectAll }
    ]);
  }

  return null;
}

function attachContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const menu = createContextMenu(params);
    if (menu) menu.popup({ window: win });
  });
}

async function loadHistoryForUi() {
  await ensureProductFolders();
  const history = await readJson(HISTORY_FILE, []);
  return hydrateHistoryForUi(history);
}

async function saveHistoryToDisk(history) {
  await ensureProductFolders();
  const normalized = await normalizeHistoryForDisk(history);
  await writeJson(HISTORY_FILE, normalized);
  return hydrateHistoryForUi(normalized);
}

async function backupCurrentHistory() {
  const current = await readJson(HISTORY_FILE, []);
  await fs.mkdir(path.join(getAppFolder(), HISTORY_BACKUPS_DIR), { recursive: true });
  const backupName = `history-${timestampForFile()}.json`;
  const backupPath = path.join(getAppFolder(), HISTORY_BACKUPS_DIR, backupName);
  await fs.writeFile(backupPath, JSON.stringify(current, null, 2), 'utf8');
  return backupPath;
}

async function listTemplates() {
  const templatesDir = path.join(getAppFolder(), TEMPLATE_DIR);
  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isTemplateFile(entry.name))
      .map((entry) => ({
        id: displayNameFromFile(entry.name).toLowerCase(),
        name: displayNameFromFile(entry.name),
        fileName: entry.name,
        path: `./${TEMPLATE_DIR}/${entry.name}`
      }))
      .sort((a, b) => templateSortWeight(a.name) - templateSortWeight(b.name) || a.name.localeCompare(b.name, 'ru'));
  } catch (_) {
    return [];
  }
}

async function runDiagnostics() {
  await ensureProductFolders();
  const appFolder = getAppFolder();
  const templates = await listTemplates();
  const checks = [
    {
      key: 'templates',
      ok: fsSync.existsSync(path.join(appFolder, TEMPLATE_DIR)) && templates.length > 0,
      message: `В папке ${TEMPLATE_DIR} нет шаблонов меню`
    },
    {
      key: 'logo',
      ok: fsSync.existsSync(path.join(appFolder, TEMPLATE_DIR, 'logo.png')),
      message: `В папке ${TEMPLATE_DIR} нет logo.png`
    },
    {
      key: 'history',
      ok: fsSync.existsSync(path.join(appFolder, HISTORY_DIR)),
      message: `Не удалось создать папку ${HISTORY_DIR}`
    },
    {
      key: 'saved-menus',
      ok: fsSync.existsSync(path.join(appFolder, MENU_EXPORTS_DIR)),
      message: `Не удалось создать папку ${MENU_EXPORTS_DIR}`
    }
  ];

  return {
    appFolder,
    version: APP_VERSION,
    templates,
    ok: checks.every((item) => item.ok),
    warnings: checks.filter((item) => !item.ok).map((item) => item.message)
  };
}

function compareVersions(left, right) {
  const a = String(left || '').replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right || '').replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return 1;
    if ((a[i] || 0) < (b[i] || 0)) return -1;
  }
  return 0;
}

async function getUpdateManifestUrl() {
  const configPath = path.join(getAppFolder(), UPDATE_SOURCE_FILE);

  try {
    const source = await readJson(UPDATE_SOURCE_FILE, null);
    if (typeof source === 'string') return source.trim();
    if (source && typeof source === 'object') {
      return String(source.manifestUrl || source.url || source.githubLatestReleaseApi || '').trim();
    }
  } catch (_) {
    // If the file is not valid JSON, still allow a plain URL to be pasted into it.
  }

  if (fsSync.existsSync(configPath)) {
    const raw = String(await fs.readFile(configPath, 'utf8')).trim();
    if (raw && /^https?:\/\//i.test(raw)) return raw;
  }

  return DEFAULT_UPDATE_MANIFEST_URL;
}

function normalizeUpdateManifest(raw) {
  const data = Array.isArray(raw) ? raw[0] : raw;
  if (!data || typeof data !== 'object') return null;

  const latestVersion = String(data.latestVersion || data.version || data.tag_name || '').replace(/^v/i, '');
  const assets = Array.isArray(data.assets)
    ? data.assets
    : [
        ...(Array.isArray(data.assets?.links) ? data.assets.links : []),
        ...(Array.isArray(data.assets?.sources) ? data.assets.sources : [])
      ];
  const exeAsset = assets.find((asset) => /\.exe(?:$|\?)/i.test(asset.name || asset.fileName || asset.browser_download_url || asset.direct_asset_url || asset.url || ''));
  const firstAsset = exeAsset || assets[0] || {};
  const assetUrl = assets.length
    ? firstAsset.browser_download_url || firstAsset.direct_asset_url || firstAsset.downloadUrl || firstAsset.url || ''
    : '';
  const assetName = assets.length
    ? firstAsset.name || firstAsset.fileName || ''
    : '';

  return {
    latestVersion,
    downloadUrl: String(data.downloadUrl || data.download_url || assetUrl || data.html_url || data.url || ''),
    fileName: safeFileName(data.fileName || data.file_name || assetName || STABLE_LAUNCHER_NAME),
    sha256: String(data.sha256 || data.checksum || '').trim().toLowerCase(),
    releaseUrl: String(data.releaseUrl || data.release_url || data.html_url || ''),
    notes: String(data.notes || data.body || data.description || ''),
    publishedAt: data.publishedAt || data.published_at || ''
  };
}

async function checkForUpdates() {
  const manifestUrl = await getUpdateManifestUrl();
  if (!manifestUrl) {
    return {
      configured: false,
      currentVersion: APP_VERSION,
      latestVersion: '',
      updateAvailable: false,
      message: `Источник обновлений не настроен. Добавь ${UPDATE_SOURCE_FILE} рядом с exe или укажи URL в main.js.`
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(manifestUrl, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mad-Marathon-Menu-Constructor'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const manifest = normalizeUpdateManifest(await response.json());
    if (!manifest?.latestVersion) {
      throw new Error('В manifest не найдена версия');
    }

    return {
      configured: true,
      currentVersion: APP_VERSION,
      latestVersion: manifest.latestVersion,
      updateAvailable: compareVersions(manifest.latestVersion, APP_VERSION) > 0,
      downloadUrl: manifest.downloadUrl || manifest.releaseUrl,
      fileName: manifest.fileName || STABLE_LAUNCHER_NAME,
      sha256: manifest.sha256 || '',
      releaseUrl: manifest.releaseUrl || manifest.downloadUrl,
      notes: manifest.notes,
      publishedAt: manifest.publishedAt,
      source: manifestUrl
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getLauncherPath() {
  const explicitPath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (explicitPath && fsSync.existsSync(explicitPath)) return explicitPath;

  const appFolder = getAppFolder();
  const stablePath = path.join(appFolder, STABLE_LAUNCHER_NAME);
  if (fsSync.existsSync(stablePath)) return stablePath;

  try {
    const launcherName = fsSync.readdirSync(appFolder)
      .find((fileName) => /^Конструктор меню.*\.exe$/i.test(fileName));
    return launcherName ? path.join(appFolder, launcherName) : '';
  } catch (_) {
    return '';
  }
}

async function downloadFile(url, targetPath) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('Некорректная ссылка обновления');
  }

  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать обновление: HTTP ${response.status}`);
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(targetPath));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function installUpdate(update) {
  if (!update?.downloadUrl) throw new Error('В manifest нет downloadUrl');

  const launcherPath = getLauncherPath();
  if (!launcherPath) {
    throw new Error('Не найден launcher exe для замены');
  }

  const appFolder = getAppFolder();
  const updateDir = path.join(app.getPath('userData'), 'updates');
  await fs.mkdir(updateDir, { recursive: true });

  const targetPath = launcherPath;
  const downloadPath = path.join(updateDir, `${safeFileName(update.fileName || path.basename(targetPath))}.download`);
  const backupPath = `${launcherPath}.bak`;
  const scriptPath = path.join(updateDir, 'install-update.ps1');

  await downloadFile(update.downloadUrl, downloadPath);

  if (update.sha256) {
    const actual = await sha256File(downloadPath);
    if (actual.toLowerCase() !== String(update.sha256).toLowerCase()) {
      await fs.rm(downloadPath, { force: true });
      throw new Error('Контрольная сумма обновления не совпала');
    }
  }

  const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$appPid = ${process.pid}`,
    `$download = ${psLiteral(downloadPath)}`,
    `$target = ${psLiteral(targetPath)}`,
    `$backup = ${psLiteral(backupPath)}`,
    'try { Wait-Process -Id $appPid -Timeout 90 -ErrorAction SilentlyContinue } catch {}',
    'try {',
    '  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $backup -Force }',
    '  Copy-Item -LiteralPath $download -Destination $target -Force',
    '  Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target)',
    '} catch {',
    '  if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $target -Force }',
    '  exit 1',
    '} finally {',
    '  Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '}'
  ].join('\r\n');

  await fs.writeFile(scriptPath, `\uFEFF${script}`, 'utf16le');

  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    cwd: appFolder,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  setTimeout(() => app.quit(), 350);
  return { ok: true, targetPath };
}

async function installLatestUpdateIfAvailable() {
  const update = await checkForUpdates();
  if (!update?.updateAvailable || !update.downloadUrl) return { ok: true, updated: false, update };
  await installUpdate(update);
  return { ok: true, updated: true, update };
}

function scheduleSilentUpdateCheck() {
  if (!app.isPackaged) return;
  setTimeout(() => {
    installLatestUpdateIfAvailable().catch((error) => {
      console.error('Silent update failed:', error);
    });
  }, 6500);
}

async function loadDraftForUi() {
  const draft = await readJson(DRAFT_FILE, null);
  return hydrateDraftForUi(draft);
}

async function saveDraftToDisk(draft) {
  if (!draft) return null;
  const normalized = await normalizeDraftForDisk(draft);
  await writeJson(DRAFT_FILE, normalized);
  return hydrateDraftForUi(normalized);
}

async function clearDraftFromDisk() {
  await fs.rm(path.join(getAppFolder(), DRAFT_FILE), { force: true });
  await fs.rm(path.join(getAppFolder(), HISTORY_IMAGES_DIR, '__draft__'), { recursive: true, force: true });
  return true;
}

async function addDirectoryToZip(zip, sourceDir, zipDir) {
  if (!fsSync.existsSync(sourceDir)) return;
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const zipPath = `${zipDir}/${entry.name}`.replace(/\\/g, '/');
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, sourcePath, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, await fs.readFile(sourcePath));
    }
  }
}

async function exportHistoryZip() {
  await ensureProductFolders();
  const result = await dialog.showSaveDialog({
    title: 'Экспорт истории меню',
    defaultPath: path.join(getAppFolder(), HISTORY_DIR, `history-export-${timestampForFile()}.zip`),
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const history = await readJson(HISTORY_FILE, []);
  const zip = new JSZip();
  zip.file('history.json', JSON.stringify(history, null, 2));
  await addDirectoryToZip(zip, path.join(getAppFolder(), HISTORY_IMAGES_DIR), 'images');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(result.filePath, bytes);
  return { canceled: false, filePath: result.filePath };
}

async function importHistoryZip() {
  const result = await dialog.showOpenDialog({
    title: 'Импорт истории меню',
    defaultPath: path.join(getAppFolder(), HISTORY_DIR),
    properties: ['openFile'],
    filters: [
      { name: 'Архив истории', extensions: ['zip'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) return { canceled: true };

  const filePath = result.filePaths[0];
  if (path.extname(filePath).toLowerCase() === '.json') {
    const imported = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const history = await saveHistoryToDisk(imported);
    return { canceled: false, history };
  }

  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const historyFile = zip.file('history.json') || zip.file('history/history.json');
  if (!historyFile) {
    throw new Error('В архиве не найден history.json');
  }

  const imported = JSON.parse(await historyFile.async('string'));
  const historyDir = path.join(getAppFolder(), HISTORY_DIR);
  const safeRoot = path.resolve(historyDir) + path.sep;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!entryName.startsWith('images/')) continue;
    const targetPath = path.resolve(historyDir, entryName);
    if (!targetPath.startsWith(safeRoot)) continue;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, await entry.async('nodebuffer'));
  }

  const history = await saveHistoryToDisk(imported);
  return { canceled: false, history };
}

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.ico');
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Конструктор меню',
    autoHideMenuBar: true,
    backgroundColor: '#14131a',
    icon: fsSync.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  attachContextMenu(win);

  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('history:load', loadHistoryForUi);
ipcMain.handle('history:save', (_event, history) => saveHistoryToDisk(history));
ipcMain.handle('history:exportZip', exportHistoryZip);
ipcMain.handle('history:importZip', importHistoryZip);
ipcMain.handle('history:clear', async () => {
  const backupPath = await backupCurrentHistory();
  await writeJson(HISTORY_FILE, []);
  return { backupPath };
});
ipcMain.handle('history:import', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Подгрузить историю',
    defaultPath: path.join(getAppFolder(), HISTORY_DIR),
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }

  const imported = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
  const history = await saveHistoryToDisk(imported);
  return { canceled: false, history };
});
ipcMain.handle('settings:load', () => readJson(SETTINGS_FILE, null));
ipcMain.handle('settings:save', (_event, settings) => writeJson(SETTINGS_FILE, settings || {}));
ipcMain.handle('templates:list', listTemplates);
ipcMain.handle('diagnostics:check', runDiagnostics);
ipcMain.handle('app:version', () => APP_VERSION);
ipcMain.handle('folder:openSavedMenus', async () => {
  await ensureProductFolders();
  const folderPath = path.join(getAppFolder(), MENU_EXPORTS_DIR);
  await fs.mkdir(folderPath, { recursive: true });
  const error = await shell.openPath(folderPath);
  return { ok: !error, folderPath, error };
});
ipcMain.handle('updates:check', async () => {
  try {
    return await checkForUpdates();
  } catch (error) {
    return {
      configured: true,
      currentVersion: APP_VERSION,
      latestVersion: '',
      updateAvailable: false,
      error: error.message || String(error)
    };
  }
});
ipcMain.handle('updates:installLatest', async () => {
  try {
    return await installLatestUpdateIfAvailable();
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});
ipcMain.handle('updates:install', async (_event, update) => {
  try {
    return await installUpdate(update);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});
ipcMain.handle('updates:open', async (_event, url) => {
  const safeUrl = String(url || '');
  if (!/^https?:\/\//i.test(safeUrl)) return { ok: false, error: 'Некорректная ссылка обновления' };
  await shell.openExternal(safeUrl);
  return { ok: true };
});
ipcMain.handle('draft:load', loadDraftForUi);
ipcMain.handle('draft:save', (_event, draft) => saveDraftToDisk(draft));
ipcMain.handle('draft:clear', clearDraftFromDisk);

ipcMain.handle('image:save', async (_event, { dataUrl, fileName }) => {
  const outputDir = path.join(getAppFolder(), MENU_EXPORTS_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, safeFileName(fileName));
  const base64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
  await fs.writeFile(outputPath, Buffer.from(base64, 'base64'));
  return { filePath: outputPath };
});

app.whenReady().then(() => {
  createWindow();
  scheduleSilentUpdateCheck();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
