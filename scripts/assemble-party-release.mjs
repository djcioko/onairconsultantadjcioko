import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {dirname, relative, resolve, sep} from 'node:path';


const frontendRoot = resolve(process.cwd());
const serverRoot = resolve(
  process.env.PARTY_SERVER_ROOT || resolve(frontendRoot, '..', 'djcioko-livekit-server'),
);
const rawRoot = resolve(frontendRoot, 'dist', 'party-raw');
const releaseRoot = resolve(frontendRoot, 'dist', 'party');
const studioRoot = resolve(frontendRoot, 'dist', 'studio');


function inside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value && value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith(sep);
}


function requireInside(parent, child, label) {
  if (!inside(parent, child)) throw new Error(`${label} must stay inside its release root`);
  return resolve(child);
}


function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}


function asset(path, file) {
  const stats = statSync(path);
  return {file, sha256: sha256(path), size: stats.size};
}


if (!existsSync(resolve(rawRoot, 'party-guest-v1.js'))
    || !existsSync(resolve(rawRoot, 'party-room-v1.css'))
    || !existsSync(resolve(studioRoot, 'index.html'))
    || !existsSync(resolve(studioRoot, 'mediapipe'))) {
  throw new Error('Run the studio and party builds before assembling the release');
}
if (!existsSync(resolve(serverRoot, 'backend')) || !existsSync(resolve(serverRoot, 'public'))) {
  throw new Error('PARTY_SERVER_ROOT is not the prepared server clone');
}

rmSync(releaseRoot, {recursive: true, force: true});
mkdirSync(releaseRoot, {recursive: true});
for (const file of ['party-guest-v1.js', 'party-room-v1.css']) {
  copyFileSync(resolve(rawRoot, file), resolve(releaseRoot, file));
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: frontendRoot,
  encoding: 'utf8',
}).trim();
const manifest = {
  schema: 1,
  sourceCommit,
  assets: [
    asset(resolve(releaseRoot, 'party-guest-v1.js'), 'party-guest-v1.js'),
    asset(resolve(releaseRoot, 'party-room-v1.css'), 'party-room-v1.css'),
  ],
};
writeFileSync(resolve(releaseRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const studioDestination = requireInside(
  resolve(serverRoot, 'backend'),
  resolve(serverRoot, 'backend', 'live-studio'),
  'protected studio destination',
);
const partyDestination = requireInside(
  resolve(serverRoot, 'public', 'files'),
  resolve(serverRoot, 'public', 'files', 'live-party-v1'),
  'party asset destination',
);
for (const target of [studioDestination, partyDestination]) {
  rmSync(target, {recursive: true, force: true});
  mkdirSync(dirname(target), {recursive: true});
}
cpSync(studioRoot, studioDestination, {recursive: true});
cpSync(releaseRoot, partyDestination, {recursive: true});

process.stdout.write(`Assembled party release ${sourceCommit.slice(0, 12)}\n`);
