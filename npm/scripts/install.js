#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const {
  cargoInstallArgs,
  extractionCommand,
  parseChecksumManifest,
  releaseFor,
  verifyFileChecksum,
} = require('./installer-lib');

const PACKAGE_VERSION = require('../package.json').version;
const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_NAME = process.platform === 'win32' ? 'nib.exe' : 'nib-binary';
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

function getResponse(url, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirectsRemaining === 0) {
          reject(new Error('Too many redirects while downloading release asset'));
          return;
        }
        resolve(getResponse(new URL(response.headers.location, url).toString(), redirectsRemaining - 1));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }

      resolve(response);
    }).on('error', reject);
  });
}

async function downloadText(url) {
  const response = await getResponse(url);
  return new Promise((resolve, reject) => {
    let contents = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      contents += chunk;
    });
    response.on('end', () => resolve(contents));
    response.on('error', reject);
  });
}

async function downloadFile(url, destination) {
  const response = await getResponse(url);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const fail = (error) => {
      file.destroy();
      reject(error);
    };
    response.on('error', fail);
    file.on('error', fail);
    file.on('finish', () => file.close(resolve));
    response.pipe(file);
  });
}

async function tryDownloadFromGitHub() {
  const release = releaseFor(process.platform, process.arch, PACKAGE_VERSION);
  if (!release) {
    throw new Error(`No pre-built release for ${process.platform}-${process.arch}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nib-release-'));
  const archivePath = path.join(tempRoot, release.asset);
  try {
    console.log(`Downloading ${release.asset} from GitHub releases...`);
    const [checksumManifest] = await Promise.all([
      downloadText(release.checksumsUrl),
      downloadFile(release.url, archivePath),
    ]);
    const expected = parseChecksumManifest(checksumManifest).get(release.asset);
    if (!expected) {
      throw new Error(`SHA256SUMS does not contain ${release.asset}`);
    }
    verifyFileChecksum(archivePath, expected);

    const extract = extractionCommand(archivePath, tempRoot);
    execFileSync(extract.executable, extract.args, { stdio: 'ignore' });
    const extractedBinary = path.join(tempRoot, release.binary);
    if (!fs.existsSync(extractedBinary)) {
      throw new Error(`${release.asset} does not contain ${release.binary}`);
    }
    fs.copyFileSync(extractedBinary, BIN_PATH);
    if (process.platform !== 'win32') {
      fs.chmodSync(BIN_PATH, 0o755);
    }
    console.log(`Successfully installed nib to ${BIN_PATH}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function tryCargoInstall() {
  console.log('Pre-built release unavailable; trying a version-pinned cargo install...');
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'Could not install a pre-built binary and cargo is not installed.\n' +
      'Install Rust from https://rustup.rs and try again.',
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nib-cargo-'));
  try {
    console.log(`Building nib v${PACKAGE_VERSION} from source (this may take a few minutes)...`);
    execFileSync('cargo', cargoInstallArgs(PACKAGE_VERSION, tempRoot), { stdio: 'inherit' });
    const cargoBinary = path.join(tempRoot, 'bin', process.platform === 'win32' ? 'nib.exe' : 'nib');
    fs.copyFileSync(cargoBinary, BIN_PATH);
    if (process.platform !== 'win32') {
      fs.chmodSync(BIN_PATH, 0o755);
    }
    console.log('Successfully built and installed nib');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (fs.existsSync(BIN_PATH)) {
    console.log('nib binary already exists, skipping install');
    return;
  }

  try {
    await tryDownloadFromGitHub();
  } catch (error) {
    console.log(`GitHub download failed: ${error.message}`);
    tryCargoInstall();
  }
}

main().catch((error) => {
  console.error('Failed to install nib:', error.message);
  process.exit(1);
});
