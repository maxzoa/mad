const fs = require('node:fs');
const path = require('node:path');

const rootDir = __dirname;
const input = process.argv[2] || 'patch';
const packagePath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');
const mainPath = path.join(rootDir, 'main.js');
const indexPath = path.join(rootDir, 'index.html');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function nextVersion(current, mode) {
  if (/^\d+\.\d+\.\d+$/.test(mode)) return mode;

  const parts = String(current).split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Некорректная текущая версия: ${current}`);
  }

  if (mode === 'major') return `${parts[0] + 1}.0.0`;
  if (mode === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (mode === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

  throw new Error('Используй patch, minor, major или точную версию вроде 2.0.2');
}

function replaceOne(content, pattern, replacement, fileName) {
  if (!pattern.test(content)) {
    throw new Error(`Не найдено место версии в ${fileName}`);
  }
  return content.replace(pattern, replacement);
}

const pkg = readJson(packagePath);
const version = nextVersion(pkg.version, input);
pkg.version = version;
writeJson(packagePath, pkg);

if (fs.existsSync(packageLockPath)) {
  const lock = readJson(packageLockPath);
  lock.version = version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = version;
  }
  writeJson(packageLockPath, lock);
}

const main = fs.readFileSync(mainPath, 'utf8');
fs.writeFileSync(
  mainPath,
  replaceOne(main, /const APP_VERSION = '(\d+\.\d+\.\d+)';/, `const APP_VERSION = '${version}';`, 'main.js'),
  'utf8'
);

let index = fs.readFileSync(indexPath, 'utf8');
index = replaceOne(index, /<div class="app-version" id="appVersion">v\d+\.\d+\.\d+<\/div>/, `<div class="app-version" id="appVersion">v${version}</div>`, 'index.html');
index = replaceOne(index, /const APP_VERSION = '(\d+\.\d+\.\d+)';/, `const APP_VERSION = '${version}';`, 'index.html');
fs.writeFileSync(indexPath, index, 'utf8');

console.log(version);
