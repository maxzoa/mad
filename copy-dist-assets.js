const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, 'dist');
const unpackedDir = path.join(distDir, 'win-unpacked');
const releaseDir = path.join(distDir, 'Готовый продукт');
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const updateSourceFile = 'update-source.json';

function copyTemplates(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  const templatesDir = path.join(targetDir, 'templates');
  const sourceTemplatesDir = path.join(__dirname, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });

  for (const asset of fs.readdirSync(sourceTemplatesDir)) {
    if (!imageExtensions.has(path.extname(asset).toLowerCase())) continue;
    fs.copyFileSync(path.join(sourceTemplatesDir, asset), path.join(templatesDir, asset));
  }

  fs.mkdirSync(path.join(targetDir, 'history'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'saved-menus'), { recursive: true });

  const updateSourcePath = path.join(__dirname, updateSourceFile);
  if (fs.existsSync(updateSourcePath)) {
    fs.copyFileSync(updateSourcePath, path.join(targetDir, updateSourceFile));
  }
}

function prepareReleaseDir() {
  fs.mkdirSync(releaseDir, { recursive: true });

  for (const item of fs.readdirSync(releaseDir)) {
    if (item === 'history' || item === 'saved-menus') continue;
    fs.rmSync(path.join(releaseDir, item), { recursive: true, force: true });
  }
}

copyTemplates(distDir);
copyTemplates(unpackedDir);

for (const item of fs.readdirSync(distDir)) {
  if (item.toLowerCase().endsWith('.exe')) {
    fs.rmSync(path.join(distDir, item), { force: true });
  }
}

prepareReleaseDir();
copyTemplates(releaseDir);
