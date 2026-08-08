const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RELEASES = {
  'darwin-x64': {
    asset: 'nib-macos-x86_64.tar.gz',
    binary: 'nib',
  },
  'darwin-arm64': {
    asset: 'nib-macos-aarch64.tar.gz',
    binary: 'nib',
  },
  'linux-x64': {
    asset: 'nib-linux-x86_64.tar.gz',
    binary: 'nib',
  },
  'win32-x64': {
    asset: 'nib-windows-x86_64.zip',
    binary: 'nib.exe',
  },
};

function releaseFor(platform, arch, version) {
  const release = RELEASES[`${platform}-${arch}`];
  if (!release) {
    return undefined;
  }

  const baseUrl = `https://github.com/douglance/nib/releases/download/v${version}`;
  return {
    ...release,
    url: `${baseUrl}/${release.asset}`,
    checksumsUrl: `${baseUrl}/SHA256SUMS`,
  };
}

function parseChecksumManifest(contents) {
  const checksums = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match) {
      checksums.set(path.basename(match[2]), match[1].toLowerCase());
    }
  }
  return checksums;
}

function verifyFileChecksum(filePath, expected) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}`);
  }
}

function extractionCommand(archivePath, destination) {
  return archivePath.endsWith('.zip')
    ? { executable: 'tar', args: ['-xf', archivePath, '-C', destination] }
    : { executable: 'tar', args: ['-xzf', archivePath, '-C', destination] };
}

function cargoInstallArgs(version, root) {
  return [
    'install',
    '--git',
    'https://github.com/douglance/nib',
    '--tag',
    `v${version}`,
    '--root',
    root,
  ];
}

module.exports = {
  cargoInstallArgs,
  extractionCommand,
  parseChecksumManifest,
  releaseFor,
  verifyFileChecksum,
};
