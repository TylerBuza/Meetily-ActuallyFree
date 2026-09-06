import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dist = resolve(process.argv[2] || join(repo, 'dist'));
const config = JSON.parse(await readFile(join(repo, 'frontend/src-tauri/tauri.conf.json'), 'utf8'));
const latest = JSON.parse(await readFile(join(dist, 'latest.json'), 'utf8'));
const version = config.version;
const engine = `Meetily-ActuallyFree-${version}-x64-universal-updater.exe`;
const setup = `Meetily-ActuallyFree-${version}-x64-universal-setup.exe`;
const platform = latest.platforms['windows-x86_64'];
assert.equal(latest.version, version);
assert.deepEqual(Object.keys(latest.platforms), ['windows-x86_64']);
assert.equal(platform.url, `https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/v${version}/${engine}`);
assert.equal(platform.signature, (await readFile(join(dist, `${engine}.sig`), 'utf8')).trim());

async function hash(path, algorithm = 'sha256') {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest();
}

const sums = (await readFile(join(dist, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
assert.equal(sums.length, 4);
const names = [];
for (const line of sums) {
  const [, expected, name] = line.match(/^([a-f0-9]{64})  (.+)$/) || [];
  assert.ok(name && name === basename(name), 'Invalid checksum entry');
  assert.equal((await hash(join(dist, name))).toString('hex'), expected, name);
  names.push(name);
}
assert.deepEqual(names.sort(), [setup, engine, `${engine}.sig`, 'latest.json'].sort());

// Minisign ED signatures use a BLAKE2b-512 prehash and Ed25519 signatures.
const publicLines = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim().split(/\r?\n/);
const publicBytes = Buffer.from(publicLines[1], 'base64');
const signatureLines = Buffer.from(platform.signature, 'base64').toString('utf8').trim().split(/\r?\n/);
const signature = Buffer.from(signatureLines[1], 'base64');
assert.equal(signature.subarray(0, 2).toString(), 'ED');
assert.deepEqual(signature.subarray(2, 10), publicBytes.subarray(2, 10));
const key = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes.subarray(10)]),
  format: 'der', type: 'spki',
});
assert.ok(verify(null, await hash(join(dist, engine), 'blake2b512'), key, signature.subarray(10)), 'Updater signature mismatch');
assert.ok(signatureLines[2].startsWith('trusted comment: '));
assert.ok(verify(null, Buffer.concat([
  signature.subarray(10), Buffer.from(signatureLines[2].slice('trusted comment: '.length)),
]), key, Buffer.from(signatureLines[3], 'base64')), 'Trusted comment signature mismatch');
console.log('Manifest, checksums, and updater cryptographic signatures verified.');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 600_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
const sevenZip = process.env.SEVEN_ZIP || 'C:\\Program Files\\7-Zip\\7z.exe';
run(sevenZip, ['t', join(dist, engine)]);
const extracted = await mkdtemp(join(dist, 'verify-'));
try {
  run(sevenZip, ['x', join(dist, engine), `-o${extracted}`, '-y', 'installer-variants/*', 'ffmpeg.exe', 'llama-helper.exe', 'resources/*', 'runtime-deps/*']);
  for (const name of ['meetily-cpu.exe', 'meetily-vulkan.exe', 'meetily-cuda.exe', 'meetily-vulkan-probe.exe']) {
    assert.deepEqual(await hash(join(extracted, 'installer-variants', name)),
      await hash(join(repo, 'frontend/src-tauri/installer-variants', name)), `Stale packaged variant: ${name}`);
  }
  assert.deepEqual(await hash(join(extracted, 'ffmpeg.exe')),
    await hash(join(repo, 'frontend/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe')));
} finally {
  await rm(extracted, { recursive: true, force: true });
}
run(join(dist, setup), ['--verify-payload']);
console.log(`Windows ${version} release payload verified without installing.`);
