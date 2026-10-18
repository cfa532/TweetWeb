import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
  }
  return result.stdout;
}
function elevated(program, args) {
  return process.getuid() === 0
    ? command(program, args, { stdio: 'inherit' })
    : command('sudo', [program, ...args], { stdio: 'inherit' });
}
async function readOptional(filename) {
  try { return await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export async function managedService(root, kind) {
  const account = os.userInfo().username;
  const searchPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  // systemd expands these characters even inside quoted arguments. Reject them
  // rather than generating a service with a different executable or directory.
  for (const value of [root, process.execPath, os.homedir(), account, searchPath]) {
    if (/[\r\n"%$`\\]/.test(value)) throw new Error('Service paths and PATH cannot contain quotes, newlines, %, $, backticks or backslashes.');
  }
  const id = createHash('sha256').update(root).digest('hex').slice(0, 12);
  const directory = kind === 'tus' ? path.join(root, 'tus-server') : root;
  const program = kind === 'tus' ? process.execPath : path.join(root, 'Leither');
  const argument = kind === 'tus' ? path.join(directory, 'dtweet-start.cjs') : 'run';
  const savedUnit = path.join(directory, kind === 'tus' ? '.dtweet-service' : '.dtweet-leither-service');
  const description = kind === 'tus' ? 'dTweet upload and video service' : 'Leither node installed by dTweet';
  let filename, contents, label;
  if (process.platform === 'linux') {
    await fs.access('/run/systemd/system').catch(() => {
      throw new Error('Automatic startup requires systemd. Use --no-services for a manual installation.');
    });
    command('systemctl', ['show', '--property=Version', '--value']);
    label = `dtweet-${kind}-${id}.service`;
    filename = `/etc/systemd/system/${label}`;
    const dropins = command('systemctl', ['show', label, '--property=DropInPaths', '--value']).trim();
    const fragment = command('systemctl', ['show', label, '--property=FragmentPath', '--value']).trim();
    if (dropins || (fragment && fragment !== filename)) {
      throw new Error(`Existing service ${label} has custom configuration; it was not changed.`);
    }
    contents = `[Unit]\nDescription=${description}\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nUser=${account}\nWorkingDirectory="${directory}"\nEnvironment="HOME=${os.homedir()}"\nEnvironment="PATH=${searchPath}"\nExecStart="${program}" "${argument}"\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=60\n\n[Install]\nWantedBy=multi-user.target\n`;
  } else {
    label = `uk.inoku.dtweet.${kind}.${id}`;
    filename = `/Library/LaunchDaemons/${label}.plist`;
    contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>UserName</key><string>${xml(account)}</string>\n<key>ProgramArguments</key><array><string>${xml(program)}</string><string>${xml(argument)}</string></array>\n<key>WorkingDirectory</key><string>${xml(directory)}</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(os.homedir())}</string><key>PATH</key><string>${xml(searchPath)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(path.join(directory, 'logs/dtweet-service.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(directory, 'logs/dtweet-service.log'))}</string>\n</dict></plist>\n`;
  }
  const existing = await readOptional(filename);
  const previous = await readOptional(savedUnit);
  if (existing !== null && existing !== previous && existing !== contents) {
    throw new Error(`Existing service ${filename} differs from the installer configuration; it was not replaced.`);
  }
  const active = () => {
    const result = process.platform === 'linux'
      ? spawnSync('systemctl', ['is-active', '--quiet', label])
      : spawnSync('launchctl', ['print', `system/${label}`], { stdio: 'ignore' });
    if (result.error) throw result.error;
    return result.status === 0;
  };
  return {
    label,
    configured: existing !== null,
    active,
    restart() {
      if (existing === null) throw new Error(`Service ${label} is not installed.`);
      if (process.platform === 'linux') elevated('systemctl', ['restart', label]);
      else elevated('launchctl', ['kickstart', '-k', `system/${label}`]);
    },
    stop() {
      // Also stop a systemd unit waiting in RestartSec before replacing code.
      if (process.platform === 'linux') {
        if (existing !== null || active()) elevated('systemctl', ['stop', label]);
      } else if (active()) elevated('launchctl', ['bootout', `system/${label}`]);
    },
    async start() {
      await fs.mkdir(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
      const changed = existing !== contents;
      await fs.writeFile(savedUnit, contents, { mode: 0o600 });
      if (process.platform === 'darwin') command('plutil', ['-lint', savedUnit]);
      if (changed && active()) this.stop();
      if (changed) elevated('install', ['-o', 'root', '-m', '644', savedUnit, filename]);
      if (process.platform === 'linux') {
        elevated('systemctl', ['daemon-reload']);
        elevated('systemctl', ['enable', '--now', label]);
      } else {
        elevated('launchctl', ['enable', `system/${label}`]);
        if (!active()) elevated('launchctl', ['bootstrap', 'system', filename]);
      }
      console.log(`Startup enabled: ${label}`);
    },
  };
}
