/**
 * LifeDrive network-drive downloads.
 *
 * LifeDrive's identity service builds the file or folder ZIP from a network
 * drive and serves it over plain HTTP on this machine's loopback interface
 * only. This router lets that stream leave the node on tus-server's existing
 * public port, so receivers need no certificate and no extra open port.
 *
 * Nothing here is authorized by a username: the 43-character ticket in the
 * path is a short-lived capability issued by the identity service, which
 * rechecks the share on every chunk.
 */

const express = require('express');
const http = require('http');
const { pipeline } = require('stream');

const router = express.Router();

const IDENTITY_URL = new URL(process.env.LIFEDRIVE_IDENTITY_URL || 'http://127.0.0.1:4811');
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// The only upstream headers worth forwarding. Content-Length is present for a
// single file and absent for a streamed folder ZIP.
const FORWARDED_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'cache-control',
  'x-content-type-options',
  'referrer-policy'
];

// LifeDrive's identity service probes this before it offers network-drive
// sharing, so an older tus-server without this router never enables it.
router.get('/lifedrive/ready', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ lifedrive_network_download: 1 });
});

router.all('/lifedrive/download/:ticket', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.sendStatus(405);
  }
  const { ticket } = req.params;
  if (!TICKET_PATTERN.test(ticket)) {
    return res.status(403).send('Download unavailable');
  }

  const upstream = http.request({
    protocol: IDENTITY_URL.protocol,
    hostname: IDENTITY_URL.hostname,
    port: IDENTITY_URL.port,
    path: `/v1/network-download/${ticket}`,
    method: req.method,
    // A folder ZIP may take hours; the identity service enforces its own idle lease.
    timeout: 0
  });

  upstream.on('response', (reply) => {
    if (reply.statusCode !== 200) {
      reply.resume();
      return res.status(reply.statusCode === 403 ? 403 : 502).send('Download unavailable');
    }
    for (const name of FORWARDED_HEADERS) {
      if (reply.headers[name] !== undefined) res.setHeader(name, reply.headers[name]);
    }
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);
    if (req.method === 'HEAD') {
      reply.resume();
      return res.end();
    }
    // A failed archive must not look like a finished download: pipeline
    // destroys the response socket on error, so the browser sees a broken
    // transfer instead of a truncated file with a clean end.
    pipeline(reply, res, () => {});
  });

  upstream.on('error', () => {
    if (!res.headersSent) return res.status(502).send('Download unavailable');
    res.destroy();
  });

  // Receiver cancelled or disconnected: stop reading from the network drive.
  res.on('close', () => upstream.destroy());
  upstream.end();
});

module.exports = router;
