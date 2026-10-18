import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { managedService } from './services.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const payloadRoot = path.join(packageRoot, 'payload');
const markerName = '.dtweet-install.json';
const digest = content => createHash('sha256').update(content).digest('hex');

async function optionalFile(filename) {
  try { return await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function installerPrerequisites(noService) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error('Node.js 22 or newer is required.');
  for (const program of ['npm', 'ffmpeg', 'ffprobe']) {
    const result = spawnSync(program, [program === 'npm' ? '--version' : '-version'], { encoding: 'utf8', timeout: 10_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`${program} must be installed and available on PATH. Install FFmpeg (including ffprobe) before running setup.`);
    }
  }
  if (!noService && process.getuid() !== 0) {
    const result = spawnSync('which', ['sudo'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error('Service setup requires sudo. Use --no-services for manual startup.');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(payloadRoot, 'manifest.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error('Upload payload is missing. Run npm pack from the installer source to build it.');
    throw error;
  }));
  const { version } = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('The upload payload does not match this installer version. Rebuild the npm package.');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid upload payload filename.');
    const filename = path.join(payloadRoot, 'tus-server', name);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(filename)) !== hash) {
      throw new Error(`Upload payload verification failed: ${name}`);
    }
  }
  return manifest;
}

async function portIsFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      const reason = code === 'EADDRINUSE' ? 'is already in use'
        : code === 'EACCES' ? 'cannot be used by this account'
          : `cannot be opened (${code || error.message})`;
      reject(new Error(`Warning: upload port ${port} ${reason}. Choose another port or resolve the conflict first.`));
    });
    server.listen(port, '::', () => server.close(resolve));
  });
}

/** Change only an installed upload listener; never initialize or restart Leither. */
export async function setUploadPort(root, value, options) {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Upload port must be between 1024 and 65535.');
  }
  const directory = path.join(root, 'tus-server');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The installed tus-server must be a regular directory.');
  const marker = JSON.parse(await fs.readFile(path.join(directory, markerName), 'utf8'));
  if (marker.schema !== 1) throw new Error('This tus-server is not managed by a supported dTweet installer.');
  const config = JSON.parse(await fs.readFile(path.join(root, 'SystemVars.json'), 'utf8'));
  if (port === (config.ServicePort ?? 4800)) throw new Error(`Warning: port ${port} is reserved for Leither. The saved upload port and services were left unchanged.`);
  const filename = path.join(directory, 'port');
  const portFile = await fs.lstat(filename);
  if (!portFile.isFile() || portFile.isSymbolicLink()) throw new Error('The upload port configuration must be a regular file.');
  const current = Number((await fs.readFile(filename, 'utf8')).trim());
  if (!Number.isInteger(current) || current < 1024 || current > 65535) throw new Error('The saved upload port is invalid; restore its configuration first.');
  if (port === current) {
    console.log(`tus-server already uses port ${port}. Nothing changed.`);
    return;
  }
  console.log(`Checking availability of upload port ${port}...`);
  try {
    await portIsFree(port);
  } catch (error) {
    throw new Error(`${error.message} The saved upload port and services were left unchanged.`);
  }
  console.log(`Upload port ${port} is available.`);
  const service = options.noServices ? null : await managedService(root, 'tus');
  if (service && !service.configured) throw new Error('No managed upload service is installed. Use --no-services after stopping your manually managed upload process.');
  const wasRunning = service?.active() ?? false;
  if (!service) await portIsFree(current);
  // Publish a complete configuration on the same filesystem. An interrupted
  // write cannot leave the service reading a truncated or empty port value.
  const temporary = path.join(directory, `.port-${process.pid}`);
  try {
    await fs.writeFile(temporary, `${port}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  console.log(`Upload port changed from ${current} to ${port}.`);
  if (wasRunning) {
    try {
      service.restart();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (response.ok && (await response.json()).status === 'ok') {
            console.log(`tus-server is responding on port ${port}. Leither was not restarted.`);
            console.log(`Update your profile’s cloudDrivePort and firewall/router to ${port}.`);
            return;
          }
        } catch { /* Wait for the restarted upload service to bind. */ }
        await delay(1000);
      }
      throw new Error(`No upload health response on ${port}.`);
    } catch (error) {
      throw new Error(`Port ${port} is saved, but restarting/verifying ${service.label} failed: ${error.message} Inspect the upload service before retrying.`);
    }
  }
  console.log('The new port applies on the next upload service start. Leither was not restarted.');
  console.log(`Update your profile’s cloudDrivePort and firewall/router to ${port}.`);
}

export async function prepareUploads(root, options, manifest) {
  const destination = path.join(root, 'tus-server');
  const existingStat = await fs.lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existingStat && (!existingStat.isDirectory() || existingStat.isSymbolicLink())) {
    throw new Error(`${destination} must be a regular directory, not a link.`);
  }
  const oldMarker = await optionalFile(path.join(destination, markerName));
  if (existingStat && oldMarker === null) {
    throw new Error(`${destination} already exists outside this installer. It was not replaced. Back it up and relocate it before installing the managed service.`);
  }
  const previous = oldMarker === null ? null : JSON.parse(oldMarker);
  if (previous && previous.schema !== 1) throw new Error('Unknown tus-server installation format.');
  if (previous && previous.version !== manifest.version && !options.upgrade) {
    throw new Error(`tus-server is installed by @inoku/dtweet ${previous.version}. Rerun with --upgrade to replace its code; uploads and the configured port will be retained.`);
  }
  // Do not silently overwrite edits made directly to installed application code.
  if (previous) {
    for (const [name, hash] of Object.entries(previous.files)) {
      if (path.basename(name) !== name) throw new Error('Invalid installed upload manifest.');
      const filename = path.join(destination, name);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(filename)) !== hash) {
        throw new Error(`Installed tus-server file ${name} was modified. Preserve those edits before upgrading.`);
      }
    }
    if (previous.version === manifest.version && JSON.stringify(previous.files) !== JSON.stringify(manifest.files)) {
      throw new Error('This installer version has different upload code. Use a new package version.');
    }
  }
  const portValue = (await optionalFile(path.join(destination, 'port')))?.trim();
  if (previous && (!portValue || !/^\d+$/.test(portValue))) throw new Error('Restore the numeric tus-server port file before upgrading.');
  if (portValue && options.tusPort && Number(portValue) !== Number(options.tusPort)) {
    throw new Error('The existing upload port was preserved. Edit tus-server/port to change it, then restart the upload service.');
  }
  const port = Number(portValue || options.tusPort || 8010);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Upload PORT must be between 1024 and 65535.');
  const nodeConfig = JSON.parse(await fs.readFile(path.join(root, 'SystemVars.json'), 'utf8'));
  if (port === (nodeConfig.ServicePort ?? 4800)) throw new Error('Leither and tus-server must use different ports.');
  const service = options.noServices ? null : await managedService(root, 'tus');
  const upgrading = previous !== null && previous.version !== manifest.version;
  if (!service?.active()) await portIsFree(port);

  return {
    port,
    directory: destination,
    async install() {
      if (!previous || upgrading) {
        // Install locked dependencies before stopping the existing upload service.
        const staging = await fs.mkdtemp(path.join(root, '.dtweet-tus-'));
        await fs.chmod(staging, 0o700);
        try {
          for (const name of Object.keys(manifest.files)) await fs.copyFile(path.join(payloadRoot, 'tus-server', name), path.join(staging, name));
          console.log('Installing locked tus-server production dependencies...');
          const npm = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'inherit' });
          if (npm.error || npm.status !== 0) throw new Error(`tus-server dependencies failed to install: ${npm.error?.message || npm.status}`);
          await fs.writeFile(path.join(staging, 'port'), `${port}\n`, { mode: 0o600, flag: 'wx' });
          await fs.writeFile(path.join(staging, markerName), `${JSON.stringify({ schema: 1, ...manifest }, null, 2)}\n`, { mode: 0o600 });
          if (!previous) {
            await fs.rename(staging, destination);
          } else {
            const backups = path.join(root, '.dtweet-backups');
            await fs.mkdir(backups, { recursive: true, mode: 0o700 });
            const backup = await fs.mkdtemp(path.join(backups, 'tus-'));
            for (const name of [...Object.keys(previous.files), markerName, 'port']) await fs.copyFile(path.join(destination, name), path.join(backup, name));
            const oldService = await optionalFile(path.join(destination, '.dtweet-service'));
            if (oldService !== null) await fs.writeFile(path.join(backup, '.dtweet-service'), oldService, { mode: 0o600 });
            console.log(`Previous upload code and configuration retained at ${backup}`);
            await service?.stop();
            // Keep uploads, registries, logs and private configuration in place.
            // Only installer-owned sources and dependencies are replaced.
            await fs.rename(path.join(destination, 'node_modules'), path.join(backup, 'node_modules'));
            for (const name of Object.keys(manifest.files)) await fs.copyFile(path.join(staging, name), path.join(destination, name));
            await fs.rename(path.join(staging, 'node_modules'), path.join(destination, 'node_modules'));
            await fs.copyFile(path.join(staging, markerName), path.join(destination, markerName));
          }
        } finally {
          await fs.rm(staging, { recursive: true, force: true });
        }
      }
      await fs.mkdir(path.join(destination, 'logs'), { recursive: true, mode: 0o700 });
      if (service) {
        await service.start();
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if (!service.active()) throw new Error(`Upload service ${service.label} stopped. Inspect its logs before rerunning.`);
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
            if (response.ok && (await response.json()).status === 'ok') return;
          } catch { /* The managed process can still be loading its modules. */ }
          await delay(1000);
        }
        throw new Error(`tus-server did not become ready on ${port}. Inspect ${service.label}; its files were retained.`);
      }
      console.log(`Manual upload startup: ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(destination, 'dtweet-start.cjs'))}`);
    },
  };
}
