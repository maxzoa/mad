const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = __dirname;
const electronBuilder = path.join(
  rootDir,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js'
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`${path.basename(command)} stopped by ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.status}`);
  }
}

function runNode(script, args = []) {
  run(process.execPath, [path.join(rootDir, script), ...args]);
}

let failed = null;

try {
  runNode('preserve-product-data.js', ['backup']);
  run(process.execPath, [electronBuilder, '--win', '--dir']);
  runNode('copy-dist-assets.js');
  runNode('build-launcher.js');
} catch (error) {
  failed = error;
} finally {
  try {
    runNode('preserve-product-data.js', ['restore']);
  } catch (restoreError) {
    console.error(restoreError);
    if (!failed) failed = restoreError;
  }
}

if (failed) {
  console.error(failed);
  process.exit(1);
}
