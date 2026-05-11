const fs = require('node:fs');
const path = require('node:path');

const releaseDir = path.join(__dirname, 'dist', 'Готовый продукт');
const backupDir = path.join(__dirname, '.build-preserve');
const userFolders = ['history', 'saved-menus'];
const mode = process.argv[2];

function copyFolder(source, target) {
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);

  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyFolder(path.join(source, entry), path.join(target, entry));
    }
    return;
  }

  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function backup() {
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true });

  for (const folder of userFolders) {
    copyFolder(path.join(releaseDir, folder), path.join(backupDir, folder));
  }
}

function restore() {
  if (!fs.existsSync(backupDir)) return;
  fs.mkdirSync(releaseDir, { recursive: true });

  for (const folder of userFolders) {
    const source = path.join(backupDir, folder);
    const target = path.join(releaseDir, folder);
    if (!fs.existsSync(source)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    copyFolder(source, target);
  }

  fs.rmSync(backupDir, { recursive: true, force: true });
}

if (mode === 'backup') {
  backup();
} else if (mode === 'restore') {
  restore();
} else {
  throw new Error('Use "backup" or "restore"');
}
