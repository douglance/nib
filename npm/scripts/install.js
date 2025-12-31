#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PACKAGE_VERSION = require('../package.json').version;
const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_NAME = process.platform === 'win32' ? 'nib.exe' : 'nib-binary';
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// Platform detection
const PLATFORM = process.platform;
const ARCH = process.arch;

function getPlatformTarget() {
  const targets = {
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  };
  return targets[`${PLATFORM}-${ARCH}`];
}

function downloadBinary(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        https.get(response.headers.location, (res) => {
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.chmodSync(dest, 0o755);
            resolve();
          });
        }).on('error', reject);
      } else if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(dest, 0o755);
          resolve();
        });
      } else {
        reject(new Error(`Failed to download: ${response.statusCode}`));
      }
    }).on('error', reject);
  });
}

async function tryDownloadFromGitHub() {
  const target = getPlatformTarget();
  if (!target) {
    throw new Error(`Unsupported platform: ${PLATFORM}-${ARCH}`);
  }

  const releaseUrl = `https://github.com/douglance/nib/releases/download/v${PACKAGE_VERSION}/nib-${target}`;
  console.log(`Downloading nib from GitHub releases...`);
  console.log(`  URL: ${releaseUrl}`);

  await downloadBinary(releaseUrl, BIN_PATH);
  console.log(`Successfully installed nib to ${BIN_PATH}`);
}

function tryCargoInstall() {
  console.log('GitHub release not available, trying cargo install...');

  try {
    execSync('cargo --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      'Could not download pre-built binary and cargo is not installed.\n' +
      'Please install Rust from https://rustup.rs and try again.'
    );
  }

  console.log('Building nib from source (this may take a few minutes)...');

  // Build to a temp location - install from GitHub since crates.io name is taken
  const tempRoot = path.join(__dirname, '..', '.cargo-tmp');
  execSync(`cargo install --git https://github.com/douglance/nib --root "${tempRoot}"`, {
    stdio: 'inherit',
  });

  // Move to expected location
  const cargoOutput = path.join(tempRoot, 'bin', 'nib');
  fs.renameSync(cargoOutput, BIN_PATH);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log('Successfully built and installed nib');
}

async function main() {
  // Ensure bin directory exists
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  // Skip if binary already exists (e.g., during npm pack)
  if (fs.existsSync(BIN_PATH)) {
    console.log('nib binary already exists, skipping install');
    return;
  }

  try {
    await tryDownloadFromGitHub();
  } catch (err) {
    console.log(`GitHub download failed: ${err.message}`);
    tryCargoInstall();
  }
}

main().catch((err) => {
  console.error('Failed to install nib:', err.message);
  process.exit(1);
});
