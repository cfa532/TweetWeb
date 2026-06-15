const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function escapeShellArg(arg) {
  return `'${String(arg).replace(/'/g, "'\"'\"'")}'`;
}

function getLeitherBinaryPath() {
  const leitherPath = process.env.LEITHER_PATH;
  if (!leitherPath) {
    throw new Error('LEITHER_PATH environment variable is not set.');
  }

  let finalPath = leitherPath;
  if (!fs.existsSync(finalPath)) {
    const dirPath = path.dirname(leitherPath);
    const uppercasePath = path.join(dirPath, 'Leither');
    const appendedPath = path.join(leitherPath, 'Leither');

    if (fs.existsSync(uppercasePath)) {
      finalPath = uppercasePath;
    } else if (fs.existsSync(appendedPath)) {
      finalPath = appendedPath;
    } else {
      throw new Error(`Leither binary not found. Tried: ${leitherPath}, ${uppercasePath}, ${appendedPath}`);
    }
  }

  const stat = fs.statSync(finalPath);
  if (stat.isDirectory()) {
    finalPath = path.join(finalPath, 'Leither');
  }

  if (!fs.existsSync(finalPath) || !fs.statSync(finalPath).isFile()) {
    throw new Error(`Leither path is not a file: ${finalPath}`);
  }

  const finalBaseName = path.basename(finalPath);
  if (finalBaseName.toLowerCase() === 'leither' && finalBaseName !== 'Leither') {
    throw new Error(`Leither binary name must be 'Leither' with uppercase L, but found '${finalBaseName}'`);
  }

  return finalPath;
}

function extractCid(output) {
  const trimmedOutput = String(output || '').trim();
  const ipfsAddOkMatch = trimmedOutput.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
  if (ipfsAddOkMatch) {
    return ipfsAddOkMatch[1];
  }

  const cidMatch = trimmedOutput.match(/(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/);
  return cidMatch ? cidMatch[1] : null;
}

function isValidCid(cid) {
  return /^(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})$/.test(String(cid || ''));
}

function addPathWithCli(filePath, timeoutMs) {
  const leitherPath = getLeitherBinaryPath();
  const fullCommand = `"${leitherPath}" ipfs add ${escapeShellArg(filePath)}`;

  return new Promise((resolve, reject) => {
    const child = exec(fullCommand, {
      maxBuffer: 1024 * 1024 * 100,
      timeout: timeoutMs
    }, (error, stdout, stderr) => {
      if (error) {
        if (stderr) {
          error.message = `${error.message}\n${stderr}`;
        }
        reject(error);
        return;
      }

      const cid = extractCid(stdout);
      if (!cid) {
        reject(new Error(`Failed to extract CID from Leither output: ${String(stdout || '').trim()}`));
        return;
      }
      resolve(cid);
    });

    child.on('error', reject);
  });
}

async function addPathWithClient(filePath) {
  if (!global.getLeitherConnection) {
    throw new Error('Leither client pool is not available.');
  }

  const client = await global.getLeitherConnection();
  try {
    const result = await client.IpfsAdd(filePath);
    const cid = extractCid(result) || (isValidCid(result) ? result : null);
    if (!cid) {
      throw new Error(`Failed to extract CID from IpfsAdd result: ${JSON.stringify(result)}`);
    }
    return cid;
  } finally {
    if (global.releaseLeitherConnection) {
      global.releaseLeitherConnection(client);
    }
  }
}

async function addPathToIpfs(filePath, options = {}) {
  const timeoutMs = options.timeoutMs || 6 * 60 * 60 * 1000;
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    return await addPathWithCli(filePath, timeoutMs);
  } catch (cliError) {
    console.warn('[IPFS] Leither CLI add failed, trying client fallback:', cliError.message);
    return addPathWithClient(filePath);
  }
}

function buildGatewayUrl(cid) {
  const gateway = (process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs').replace(/\/+$/, '');
  return `${gateway}/${encodeURIComponent(cid)}`;
}

module.exports = {
  addPathToIpfs,
  buildGatewayUrl,
  extractCid,
  isValidCid
};
