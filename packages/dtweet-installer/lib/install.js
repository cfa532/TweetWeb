import fs from 'node:fs/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

// This is TweetWeb's RELEASE app, shared by all serving nodes. Never publish
// a new app or substitute the debug MID when setting up a provider.
const RELEASE_MID = 'heWgeGkeBX2gaENbIBS_Iy1mdTS';
const DOWNLOAD_BASE = 'http://vzhan.cn/mm/Fc1BRTFafOGzq5P8KmkVJqwS2v2/';

const HELP = `Usage: dtweet [options]

Install/start Leither, synchronize the dTweet release app, and provide it.
Existing Leither binaries, configuration, keys, and applications are retained.
HLS video requires a separately configured tus-server and FFmpeg (with ffprobe).
Setup guide: https://github.com/cfa532/TweetWeb/blob/main/docs/SETUP.md

  --leither-root DIR       Select an existing node or a new installation directory
  --port NUMBER           New node's port (default: 8800)
  --bootstrap ADDRESS     New node's bootstrap peer (default: Leither defaults)
  --leither-version Vx.y.z  Runtime version for a new install (default: latest)
  --mid                    Print the release app MID and exit
  -h, --help               Show this help

Without --leither-root, use the sole running node, a Leither in the current
directory, or ~/Leither, in that order. Multiple running nodes require a choice.
Run this command again to synchronize and provide the latest app publication.
`;

function parseOptions(args) {
  const options = {};
  const names = new Map([
    ['--leither-root', 'root'], ['--port', 'port'],
    ['--bootstrap', 'bootstrap'], ['--leither-version', 'version'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const name = names.get(args[i]);
    if (!name || !args[i + 1] || args[i + 1].startsWith('-')) {
      throw new Error(`Unknown option or missing value: ${args[i]}. Use --help.`);
    }
    options[name] = args[++i];
  }
  if (options.port && (!/^\d+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65535)) {
    throw new Error('--port must be between 1024 and 65535.');
  }
  if (options.version && !/^V\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error('--leither-version must look like V0.24.29.');
  }
  return options;
}

async function exists(filename) {
  try {
    await fs.stat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect Leither processes using ${command}: ${result.error?.message || result.stderr.trim()}`);
  }
  return result.stdout;
}

async function runningRoots() {
  const roots = new Set();
  const processes = capture('ps', ['-axo', 'pid=,comm=']);
  for (const line of processes.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || path.basename(match[2]) !== 'Leither') continue;
    const pid = match[1];
    let executable;
    try {
      if (process.platform === 'linux') {
        executable = (await fs.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
      } else {
        // ps may show only the process name on macOS. lsof reports the actual
        // executable, including paths containing spaces, as a separate field.
        executable = capture('lsof', ['-a', '-p', pid, '-d', 'txt', '-Fn'])
          .split('\n').find(field => field.startsWith('n/') && path.basename(field.slice(1)) === 'Leither')?.slice(1);
      }
      if (!executable) throw new Error('executable path is unavailable');
      roots.add(await fs.realpath(path.dirname(executable)));
    } catch (error) {
      // Do not create another node when a running instance cannot be inspected.
      throw new Error(`Cannot locate Leither process ${pid}. Run as its owner. ${error.message}`);
    }
  }
  return roots;
}

async function selectRoot(options, roots) {
  if (options.root) return path.resolve(options.root);
  if (roots.size > 1) {
    throw new Error(`More than one Leither node is running. Use --leither-root with one of:\n${[...roots].join('\n')}`);
  }
  if (roots.size === 1) return [...roots][0];
  if (await exists(path.join(process.cwd(), 'Leither'))) return process.cwd();
  return path.join(os.homedir(), 'Leither');
}

async function request(url, timeout = 30_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  }
  return response;
}

async function downloadRuntime(root, requestedVersion) {
  if (!['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`Automatic Leither download does not support ${process.arch}. Install its binary manually first.`);
  }
  let version = requestedVersion;
  if (!version) {
    const listing = await (await request(DOWNLOAD_BASE)).text();
    const versions = [...listing.matchAll(/href="(V\d+\.\d+\.\d+)\//g)].map(match => match[1]);
    versions.sort((a, b) => {
      const left = a.slice(1).split('.').map(Number);
      const right = b.slice(1).split('.').map(Number);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });
    version = versions.at(-1);
    if (!version) throw new Error('No Leither release versions found in the official download listing.');
  }
  const architecture = process.arch === 'x64' ? 'amd64' : 'arm64';
  const url = `${DOWNLOAD_BASE}${version}/Leither.${process.platform}.${architecture}`;
  console.log(`Downloading Leither ${version} (${process.platform}/${architecture})...`);
  const checksum = (await (await request(`${url}.sha256`)).text()).trim().split(/\s+/)[0];
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) throw new Error('Leither SHA-256 sidecar is missing or invalid.');

  const temporary = await fs.mkdtemp(path.join(root, '.dtweet-download-'));
  try {
    const filename = path.join(temporary, 'Leither');
    const response = await request(url, 600_000);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    if (hash.digest('hex') !== checksum.toLowerCase()) {
      throw new Error('Leither SHA-256 verification failed. The binary was not installed.');
    }
    await fs.chmod(filename, 0o755);
    // Link only after verification; unlike rename, this cannot replace an
    // existing executable if another installer created one in the meantime.
    await fs.link(filename, path.join(root, 'Leither'));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function run(root, args) {
  const result = spawnSync(path.join(root, 'Leither'), args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`Leither ${args.join(' ')} failed: ${result.error?.message || result.signal || `exit ${result.status}`}`);
  }
}

async function waitForNode(root) {
  console.log('Waiting for the Leither service...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = spawnSync(path.join(root, 'Leither'), ['swarm', 'local'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
    });
    if (!result.error && result.status === 0 && /\/ip[46]\/[^\s]+\/tcp\/\d+/.test(result.stdout)) return;
    await delay(1000);
  }
  throw new Error(`Leither did not become ready within 60 seconds. Check ${path.join(root, 'Leither.log')} before rerunning.`);
}

export async function main(args) {
  if (args.length === 1 && ['--help', '-h', '--mid'].includes(args[0])) {
    console.log(args[0] === '--mid' ? RELEASE_MID : HELP);
    return;
  }
  const options = parseOptions(args);
  if (!['linux', 'darwin'].includes(process.platform)) {
    throw new Error('This installer supports Linux and macOS. Use Leither’s manual installation for Windows.');
  }
  const roots = await runningRoots();
  let root = await selectRoot(options, roots);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  root = await fs.realpath(root);
  const binary = path.join(root, 'Leither');
  const configured = await exists(path.join(root, 'SystemVars.json'));
  const installed = await exists(binary);

  if (configured && (options.port || options.bootstrap)) {
    throw new Error('--port and --bootstrap apply only to a new node; this node already has SystemVars.json.');
  }
  if (installed && options.version) {
    throw new Error('--leither-version applies only to a new binary installation. Upgrade an existing runtime separately.');
  }
  if (!configured && (await fs.readdir(root)).some(name => name !== 'Leither')) {
    throw new Error(`Uninitialized directory ${root} contains other files. Choose an empty directory or an initialized Leither node.`);
  }
  if (configured && !installed) {
    throw new Error(`Existing node ${root} has no Leither binary. Restore its runtime before running setup.`);
  }
  if (roots.has(root) && !configured) {
    throw new Error(`The running node at ${root} has no SystemVars.json. Resolve its configuration before rerunning.`);
  }

  console.log(`Leither directory: ${root}`);
  if (!installed) await downloadRuntime(root, options.version);
  await fs.access(binary, constants.X_OK);
  if (!configured) {
    const initArgs = ['init', '-p', options.port || '8800'];
    if (options.bootstrap) initArgs.push('-b', options.bootstrap);
    run(root, initArgs);
    if (!await exists(path.join(root, 'SystemVars.json'))) {
      throw new Error('Leither init did not create SystemVars.json. Inspect its output before rerunning.');
    }
  }
  if (!roots.has(root)) run(root, ['run', '-d']);
  await waitForNode(root);

  console.log(`Synchronizing dTweet release app ${RELEASE_MID}...`);
  run(root, ['mimei', 'sync', '--mid', RELEASE_MID]);
  console.log('Announcing this node as a provider of the release app...');
  run(root, ['mimei', 'provide', '--mid', RELEASE_MID]);
  console.log(`\ndTweet release app synchronized and provided.\nRelease app MID: ${RELEASE_MID}\nLeither directory: ${root}`);
  console.log('Configure Leither startup after reboot and network access for this node.');
  console.log('\nRequired for HLS video: install and configure tus-server and FFmpeg (including ffprobe).');
  console.log('tus-server handles video uploads; FFmpeg converts them into HLS streams.');
  console.log('These components are not installed by this command.');
  console.log('Setup guide: https://github.com/cfa532/TweetWeb/blob/main/docs/SETUP.md');
}
