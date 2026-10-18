import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(packageRoot, '../../tus-server');
const destination = path.join(packageRoot, 'payload/tus-server');
// Explicit production allowlist: never package uploads, cookies, .env, signing
// keys, developer tools, tests, or a developer's node_modules directory.
const files = [
  'app.js', 'agentRoutes.js', 'commentRoutes.js', 'fileRegistry.js',
  'ipfsService.js', 'leitherDetector.js', 'netdisk.js', 'shareRoutes.js',
  'uploadedFilesBrowser.js', 'uploadRoutes.js', 'videoRoutes.js', 'zipRoutes.js',
  'package.json', 'package-lock.json',
];
await fs.access(path.join(source, 'app.js'));
await fs.rm(path.join(packageRoot, 'payload'), { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
const hashes = {};
for (const filename of files) {
  const input = path.join(source, filename);
  const stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular source file: ${filename}`);
  const content = await fs.readFile(input);
  await fs.writeFile(path.join(destination, filename), content);
  hashes[filename] = createHash('sha256').update(content).digest('hex');
}
const launcher = await fs.readFile(path.join(packageRoot, 'lib/tus-launcher.cjs'));
await fs.writeFile(path.join(destination, 'dtweet-start.cjs'), launcher);
hashes['dtweet-start.cjs'] = createHash('sha256').update(launcher).digest('hex');
const { version } = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
await fs.writeFile(path.join(packageRoot, 'payload/manifest.json'), `${JSON.stringify({ version, files: hashes }, null, 2)}\n`);
// npm pack --json is parsed by the release workflow; keep stdout pure JSON.
console.error(`Bundled ${Object.keys(hashes).length} production files for @inoku/dtweet ${version}.`);
