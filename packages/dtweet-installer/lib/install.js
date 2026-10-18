import fs from 'node:fs/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installerPrerequisites, prepareUploads, setUploadPort } from './tus.js';
import { managedService } from './services.js';

// This is TweetWeb's RELEASE app, shared by all serving nodes. Never publish
// a new app or substitute the debug MID when setting up a provider.
const RELEASE_MID = 'heWgeGkeBX2gaENbIBS_Iy1mdTS';
const DOWNLOAD_BASE = 'http://vzhan.cn/mm/Fc1BRTFafOGzq5P8KmkVJqwS2v2/';

const HELP = `Usage: dtweet [options]
       dtweet set-tus-port NUMBER [--leither-root DIR] [--no-services]
       dtweet help [set-tus-port]

Install/start Leither, synchronize/provide dTweet, and install tus-server.
Existing Leither binaries, configuration, keys, and applications are retained.
Uploads are installed inside <Leither directory>/tus-server.
Requires Node.js 22+, npm, FFmpeg and ffprobe on PATH.
Setup guide: https://github.com/cfa532/TweetWeb/blob/main/docs/SETUP.md

  --leither-root DIR       Select an existing node or a new installation directory
  --port NUMBER           New node's port (default: 8800)
  --bootstrap ADDRESS     New node's bootstrap peer (default: Leither defaults)
  --leither-version Vx.y.z  Runtime version for a new install (default: latest)
  --tus-port NUMBER       New upload service's port (default: 8010)
  --upgrade               Upgrade installer-managed tus-server; keep port/uploads
  --no-services           Leave service registration/manual upload startup to you
  --mid                    Print the release app MID and exit
  -h, --help               Show this help

Without --leither-root, use the sole running node, a Leither in the current
directory, or ~/Leither, in that order. Multiple running nodes require a choice.
Run this command again to synchronize and provide the latest app publication.
`;

const PORT_HELP = `Usage: dtweet set-tus-port NUMBER [options]

Change the upload port of an existing installer-managed tus-server.
NUMBER must be between 1024 and 65535 and differ from Leither's port.
Availability is checked before saving. An unavailable port prints a warning
and leaves the saved port and services unchanged.
Only a running managed upload service is restarted;
Leither is left running. A stopped service uses the port on its next start.

  --leither-root DIR  Select the installed Leither node
  --no-services      Save the port after stopping your manually managed upload process
  -h, --help         Show this help

Example: dtweet set-tus-port 8012 --leither-root /path/to/Leither

Update your profile's cloudDrivePort and firewall/router rules to match.
Help does not inspect nodes, download files or change services.
`;

function parseOptions(args) {
  const options = {};
  const names = new Map([
    ['--leither-root', 'root'], ['--port', 'port'],
    ['--bootstrap', 'bootstrap'], ['--leither-version', 'version'],
    ['--tus-port', 'tusPort'],
  ]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--upgrade' || args[i] === '--no-services') {
      options[args[i] === '--upgrade' ? 'upgrade' : 'noServices'] = true;
      continue;
    }
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
  if (options.tusPort && (!/^\d+$/.test(options.tusPort) || Number(options.tusPort) < 1024 || Number(options.tusPort) > 65535)) {
    throw new Error('--tus-port must be between 1024 and 65535.');
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
  if (args[0] === 'help') {
    if (args.length > 2 || (args[1] && args[1] !== 'set-tus-port')) {
      throw new Error('Use dtweet help or dtweet help set-tus-port.');
    }
    console.log(args[1] === 'set-tus-port' ? PORT_HELP : HELP);
    return;
  }
  if (args.length === 2 && args[0] === 'set-tus-port' && ['--help', '-h'].includes(args[1])) {
    console.log(PORT_HELP);
    return;
  }
  if (args.length === 1 && ['--help', '-h', '--mid'].includes(args[0])) {
    console.log(args[0] === '--mid' ? RELEASE_MID : HELP);
    return;
  }
  if (args[0] === 'set-tus-port') {
    const value = args[1];
    if (!value || !/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
      throw new Error('Use dtweet set-tus-port NUMBER [--leither-root DIR] [--no-services], with a port between 1024 and 65535.');
    }
    const options = parseOptions(args.slice(2));
    if (Object.keys(options).some(key => !['root', 'noServices'].includes(key))) {
      throw new Error('set-tus-port accepts only --leither-root and --no-services.');
    }
    if (!['linux', 'darwin'].includes(process.platform)) throw new Error('This command supports Linux and macOS.');
    const root = await fs.realpath(options.root ? path.resolve(options.root) : await selectRoot(options, await runningRoots()));
    await setUploadPort(root, value, options);
    return;
  }
  const options = parseOptions(args);
  if (!['linux', 'darwin'].includes(process.platform)) {
    throw new Error('This installer supports Linux and macOS. Use Leither’s manual installation for Windows.');
  }
  const uploadManifest = await installerPrerequisites(options.noServices);
  const roots = await runningRoots();
  let root = await selectRoot(options, roots);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  root = await fs.realpath(root);
  const binary = path.join(root, 'Leither');
  const configured = await exists(path.join(root, 'SystemVars.json'));
  const installed = await exists(binary);

  if (options.upgrade && (!configured || !await exists(path.join(root, 'tus-server', '.dtweet-install.json')))) {
    throw new Error('--upgrade requires an initialized Leither node and a tus-server managed by this installer.');
  }

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
  if (!roots.has(root)) {
    if (!options.noServices && (!configured || await exists(path.join(root, '.dtweet-leither-service')))) {
      await (await managedService(root, 'leither')).start();
    } else {
      run(root, ['run', '-d']);
    }
  }
  await waitForNode(root);
  const uploads = await prepareUploads(root, options, uploadManifest);

  console.log(`Synchronizing dTweet release app ${RELEASE_MID}...`);
  run(root, ['mimei', 'sync', '--mid', RELEASE_MID]);
  console.log('Announcing this node as a provider of the release app...');
  run(root, ['mimei', 'provide', '--mid', RELEASE_MID]);
  await uploads.install();
  console.log(`\ndTweet release app synchronized and provided.\nRelease app MID: ${RELEASE_MID}\nLeither directory: ${root}`);
  console.log('Keep any existing Leither startup configuration; running nodes were not restarted.');
  console.log(`\ntus-server installed at ${uploads.directory}`);
  console.log(`Upload port: ${uploads.port}. Set your dTweet profile's cloudDrivePort to ${uploads.port}.`);
  console.log('Allow both Leither and upload ports through your firewall/router. No firewall rules were changed.');
  console.log('Setup guide: https://github.com/cfa532/TweetWeb/blob/main/docs/SETUP.md');
}
