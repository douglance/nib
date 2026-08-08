#!/usr/bin/env node

const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cargoInstallArgs,
  extractionCommand,
  parseChecksumManifest,
  releaseFor,
  verifyFileChecksum,
} = require('./installer-lib');

const VERSION = '0.3.1';

const supported = [
  ['darwin', 'x64', 'nib-macos-x86_64.tar.gz', 'nib'],
  ['darwin', 'arm64', 'nib-macos-aarch64.tar.gz', 'nib'],
  ['linux', 'x64', 'nib-linux-x86_64.tar.gz', 'nib'],
  ['win32', 'x64', 'nib-windows-x86_64.zip', 'nib.exe'],
];

for (const [platform, arch, asset, binary] of supported) {
  const release = releaseFor(platform, arch, VERSION);
  assert.equal(release.asset, asset);
  assert.equal(release.binary, binary);
  assert.equal(
    release.url,
    `https://github.com/douglance/nib/releases/download/v${VERSION}/${asset}`,
  );
  assert.equal(
    release.checksumsUrl,
    `https://github.com/douglance/nib/releases/download/v${VERSION}/SHA256SUMS`,
  );
}

assert.equal(releaseFor('linux', 'arm64', VERSION), undefined);
assert.equal(releaseFor('win32', 'arm64', VERSION), undefined);

const checksums = parseChecksumManifest([
  `${'a'.repeat(64)}  nib-linux-x86_64.tar.gz`,
  `${'b'.repeat(64)} *nib-windows-x86_64.zip`,
].join('\n'));
assert.equal(checksums.get('nib-linux-x86_64.tar.gz'), 'a'.repeat(64));
assert.equal(checksums.get('nib-windows-x86_64.zip'), 'b'.repeat(64));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nib-installer-test-'));
try {
  const archive = path.join(tempDir, 'fixture.bin');
  fs.writeFileSync(archive, 'nib');
  const digest = crypto.createHash('sha256').update('nib').digest('hex');
  verifyFileChecksum(archive, digest);
  assert.throws(() => verifyFileChecksum(archive, '0'.repeat(64)), /checksum mismatch/i);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.deepEqual(extractionCommand('/tmp/nib.tar.gz', '/tmp/out'), {
  executable: 'tar',
  args: ['-xzf', '/tmp/nib.tar.gz', '-C', '/tmp/out'],
});
assert.deepEqual(extractionCommand('C:\\nib.zip', 'C:\\out'), {
  executable: 'tar',
  args: ['-xf', 'C:\\nib.zip', '-C', 'C:\\out'],
});

assert.deepEqual(cargoInstallArgs(VERSION, '/tmp/root'), [
  'install',
  '--git',
  'https://github.com/douglance/nib',
  '--tag',
  `v${VERSION}`,
  '--root',
  '/tmp/root',
]);

console.log('installer contract tests passed');
