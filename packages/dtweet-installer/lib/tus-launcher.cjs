// Installed inside <Leither root>/tus-server. Run Leither CLI children in the
// selected node's directory rather than creating a second node under uploads.
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(__dirname);
const uploadPort = Number(fs.readFileSync(path.join(__dirname, 'port'), 'utf8').trim());
if (!Number.isInteger(uploadPort) || uploadPort < 1024 || uploadPort > 65535) throw new Error('Invalid tus-server port');
const config = JSON.parse(fs.readFileSync(path.join(root, 'SystemVars.json'), 'utf8'));
const port = config.ServicePort ?? 4800;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Leither ServicePort');
process.env.LEITHER_PATH = path.join(root, 'Leither');
process.env.LEITHER_PORT = String(port);
process.env.PORT = String(uploadPort);
process.env.NODE_ENV = 'production';
// This installer synchronizes the release app, not the existing debug default.
process.env.DTWEET_APP_ID = 'heWgeGkeBX2gaENbIBS_Iy1mdTS';
// This npm distribution contains no X session, signing key or Playwright.
process.env.COMMENT_ROUTES_ENABLED = 'false';
process.chdir(root);
require(path.join(__dirname, 'app.js'));
