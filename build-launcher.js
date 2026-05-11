const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = __dirname;
const distDir = path.join(rootDir, 'dist');
const unpackedDir = path.join(distDir, 'win-unpacked');
const releaseDir = path.join(distDir, 'Готовый продукт');
const launcherSource = path.join(rootDir, 'launcher', 'Launcher.cs');
const runtimeZip = path.join(distDir, 'runtime.zip');
const outputExe = path.join(releaseDir, 'Конструктор меню.exe');
const iconPath = path.join(rootDir, 'icon.ico');

function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

if (!fs.existsSync(unpackedDir)) {
  throw new Error(`Missing unpacked Electron app: ${unpackedDir}`);
}

const cscPath = findCsc();
if (!cscPath) {
  throw new Error('C# compiler was not found in Microsoft.NET Framework folders.');
}

fs.rmSync(runtimeZip, { force: true });
fs.mkdirSync(releaseDir, { recursive: true });

run('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  `Compress-Archive -Path '${path.join(unpackedDir, '*').replace(/'/g, "''")}' -DestinationPath '${runtimeZip.replace(/'/g, "''")}' -Force`
]);

run(cscPath, [
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  `/out:${outputExe}`,
  `/win32icon:${iconPath}`,
  `/resource:${runtimeZip},app.zip`,
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  launcherSource
]);

fs.rmSync(runtimeZip, { force: true });
