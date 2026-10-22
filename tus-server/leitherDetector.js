/** Discover the port owned by the running Leither service. */
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

async function detectLeitherPort() {
  // Only process-owned listeners establish which port belongs to Leither.
  // An HTTP response from an arbitrary port cannot establish that identity.
  for (const command of ['lsof -nP -iTCP -sTCP:LISTEN', 'netstat -tlnp']) {
    try {
      const { stdout } = await execAsync(command);
      for (const line of stdout.split('\n')) {
        const match = command.startsWith('lsof')
          ? line.match(/^Leither\s+.*\bTCP\s+\S+:(\d+)\s+\(LISTEN\)/)
          : /\b\d+\/Leither(?:\s|$)/.test(line)
            ? line.match(/^tcp6?\s+\d+\s+\d+\s+\S+:(\d+)\s/)
            : null;
        if (!match) continue;
        const port = Number(match[1]);
        if (port > 0 && port <= 65535) return port;
      }
    } catch (error) {
      console.log(`Leither listener discovery failed (${command}): ${error.message}`);
    }
  }
  return null;
}

async function getLeitherPort() {
  // The installer supplies the selected node's ServicePort from SystemVars.json.
  if (process.env.LEITHER_PORT !== undefined) {
    const port = Number(process.env.LEITHER_PORT);
    if (!/^\d+$/.test(process.env.LEITHER_PORT) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('LEITHER_PORT must be a TCP port between 1 and 65535.');
    }
    return port;
  }

  const port = await detectLeitherPort();
  if (port === null) throw new Error('Could not discover the running Leither service port.');
  return port;
}

module.exports = { detectLeitherPort, getLeitherPort };
