const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { buildGatewayUrl, isValidCid } = require('./ipfsService');

const configuredDownloadSessionTtlMs = Number(process.env.DOWNLOAD_SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const DOWNLOAD_SESSION_TTL_MS = Number.isFinite(configuredDownloadSessionTtlMs) && configuredDownloadSessionTtlMs > 0
  ? configuredDownloadSessionTtlMs
  : 24 * 60 * 60 * 1000;

function normalizeDomain(domain, req) {
  const fallback = `${req.protocol}://${req.get('host')}`;
  const raw = String(domain || fallback).trim();
  if (!raw) {
    return fallback;
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, '');
  }

  return `https://${raw.replace(/\/+$/, '')}`;
}

function parseExpiresAt(body) {
  if (body.expiresAt) {
    const millis = Date.parse(body.expiresAt);
    if (!Number.isNaN(millis)) {
      return new Date(millis).toISOString();
    }
  }

  const expiresInSeconds = Number(body.expiresInSeconds || body.expiresIn);
  if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  }

  return null;
}

function hashPassword(password) {
  if (!password) {
    return null;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash) {
    return true;
  }

  const providedHash = crypto.pbkdf2Sync(String(password || ''), passwordHash.salt, 100000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(providedHash, 'hex'), Buffer.from(passwordHash.hash, 'hex'));
}

function publicShare(share) {
  if (!share) {
    return null;
  }

  const {
    passwordHash,
    ...safeShare
  } = share;

  return {
    ...safeShare,
    passwordRequired: Boolean(passwordHash)
  };
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = decodeURIComponent(cookie.slice(0, separatorIndex));
    if (key === name) {
      return decodeURIComponent(cookie.slice(separatorIndex + 1));
    }
  }
  return null;
}

function getSessionCookieName(shareId) {
  return `tw_dl_${String(shareId || 'public').replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function getDownloadToken(req, shareId) {
  return req.query.dt
    || req.headers['x-download-token']
    || getCookie(req, getSessionCookieName(shareId));
}

function createDownloadSession(registries, share) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const shareExpiresAt = share?.expiresAt ? Date.parse(share.expiresAt) : null;
  const expiresAt = new Date(Math.min(
    now + DOWNLOAD_SESSION_TTL_MS,
    Number.isFinite(shareExpiresAt) ? shareExpiresAt : now + DOWNLOAD_SESSION_TTL_MS
  )).toISOString();

  registries.sessions.set(token, {
    token,
    shareId: share?.id || null,
    cid: share?.cid || null,
    createdAt: new Date(now).toISOString(),
    expiresAt
  });
  return { token, expiresAt };
}

function getValidDownloadSession(registries, token, share) {
  if (!token) {
    return null;
  }

  const session = registries.sessions.get(token);
  if (!session) {
    return null;
  }

  if (session.shareId !== (share?.id || null) || session.cid !== (share?.cid || null)) {
    return null;
  }

  if (session.expiresAt && Date.now() > Date.parse(session.expiresAt)) {
    registries.sessions.delete(token);
    return null;
  }

  return session;
}

function setDownloadSessionHeaders(res, share, session) {
  if (!share || !session) {
    return;
  }

  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
  const cookieName = getSessionCookieName(share.id);
  res.setHeader('Set-Cookie', `${encodeURIComponent(cookieName)}=${encodeURIComponent(session.token)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax`);
  res.setHeader('X-Download-Token', session.token);
}

function findLocalFileByCid(registries, cid) {
  const files = registries.files.read();
  return Object.values(files).find((file) => (
    file
    && file.ipfs
    && file.ipfs.cid === cid
    && file.path
    && fs.existsSync(file.path)
    && (() => {
      try {
        return fs.statSync(file.path).isFile();
      } catch (error) {
        return false;
      }
    })()
  )) || null;
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader) {
    return null;
  }

  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return { invalid: true };
  }

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null && end === null) {
    return { invalid: true };
  }

  if (start === null) {
    const suffixLength = end;
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    if (!Number.isInteger(start) || start < 0) {
      return { invalid: true };
    }
    if (end === null) {
      end = size - 1;
    }
  }

  if (!Number.isInteger(end) || end < start || start >= size) {
    return { invalid: true };
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

function contentDispositionFor(record, req) {
  const filename = encodeURIComponent(record?.name || path.basename(record?.path || 'download'));
  const disposition = req.query.inline === 'true' ? 'inline' : 'attachment';
  return `${disposition}; filename*=UTF-8''${filename}`;
}

function sendLocalFile(record, req, res) {
  const stats = fs.statSync(record.path);
  const range = parseRangeHeader(req.headers.range, stats.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', record.type || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDispositionFor(record, req));
  res.setHeader('Cache-Control', 'private, no-store');

  if (range?.invalid) {
    res.setHeader('Content-Range', `bytes */${stats.size}`);
    return res.status(416).end();
  }

  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
    res.setHeader('Content-Length', chunkSize);
    if (req.method === 'HEAD') {
      return res.end();
    }
    return fs.createReadStream(record.path, { start: range.start, end: range.end }).pipe(res);
  }

  res.setHeader('Content-Length', stats.size);
  if (req.method === 'HEAD') {
    return res.end();
  }
  return fs.createReadStream(record.path).pipe(res);
}

function proxyGateway(gatewayUrl, req, res, redirectsLeft = 3) {
  const parsed = new URL(gatewayUrl);
  const transport = parsed.protocol === 'https:' ? https : http;
  const headers = {};

  for (const headerName of ['range', 'if-range', 'if-none-match', 'if-modified-since', 'user-agent']) {
    if (req.headers[headerName]) {
      headers[headerName] = req.headers[headerName];
    }
  }

  const upstreamReq = transport.request(parsed, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers
  }, (upstreamRes) => {
    const location = upstreamRes.headers.location;
    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && location && redirectsLeft > 0) {
      upstreamRes.resume();
      const nextUrl = new URL(location, parsed).toString();
      proxyGateway(nextUrl, req, res, redirectsLeft - 1);
      return;
    }

    res.status(upstreamRes.statusCode || 502);
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value !== undefined && !['connection', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    res.setHeader('Accept-Ranges', upstreamRes.headers['accept-ranges'] || 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method === 'HEAD') {
      upstreamRes.resume();
      res.end();
      return;
    }

    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: 'Failed to fetch IPFS content', error: error.message });
      return;
    }
    res.destroy(error);
  });
  upstreamReq.end();
}

function createShareRoutes(registries) {
  const router = express.Router();

  function createShare({ fileId, fileRecord, body, req }) {
    const cid = String(body.cid || fileRecord?.ipfs?.cid || '').trim();
    if (!isValidCid(cid)) {
      const status = fileRecord?.ipfs?.status || 'unknown';
      const error = fileRecord?.ipfs?.error;
      const message = error
        ? `File is not ready to share: ${status}. ${error}`
        : `File is not ready to share: ${status}.`;
      const invalidCid = new Error(message);
      invalidCid.statusCode = 409;
      throw invalidCid;
    }

    const shareId = crypto.randomBytes(16).toString('hex');
    const domain = normalizeDomain(body.domain, req);
    const mid = body.mid || body.userMid || fileRecord?.mid || null;
    const expiresAt = parseExpiresAt(body);
    const maxDownloads = body.maxDownloads === undefined || body.maxDownloads === null || body.maxDownloads === ''
      ? null
      : Number(body.maxDownloads);

    if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1)) {
      const error = new Error('maxDownloads must be a positive integer.');
      error.statusCode = 400;
      throw error;
    }

    const params = new URLSearchParams({ cid, sid: shareId });
    if (mid) {
      params.set('mid', String(mid));
    }
    if (body.sutro !== undefined && body.sutro !== null && body.sutro !== '') {
      params.set('sutro', String(body.sutro));
    }

    const share = {
      id: shareId,
      fileId: fileId || null,
      cid,
      mid,
      name: body.name || fileRecord?.name || null,
      type: body.type || fileRecord?.type || null,
      size: body.size || fileRecord?.size || null,
      sutro: body.sutro === undefined ? null : body.sutro,
      passwordHash: hashPassword(body.password),
      expiresAt,
      maxDownloads,
      downloadCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    registries.shares.set(shareId, share);

    return {
      share,
      url: `${domain}/download?${params.toString()}`
    };
  }

  router.get('/files/:id/status', (req, res) => {
    const record = registries.files.get(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    res.json({ success: true, file: record });
  });

  router.post('/files/:id/share', (req, res) => {
    try {
      const record = registries.files.get(req.params.id);
      if (!record) {
        return res.status(404).json({ success: false, message: 'File not found' });
      }

      const { share, url } = createShare({
        fileId: req.params.id,
        fileRecord: record,
        body: req.body || {},
        req
      });

      res.status(201).json({
        success: true,
        share: publicShare(share),
        url
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to create share link'
      });
    }
  });

  router.post('/shares', (req, res) => {
    try {
      const { share, url } = createShare({
        fileId: null,
        fileRecord: null,
        body: req.body || {},
        req
      });

      res.status(201).json({
        success: true,
        share: publicShare(share),
        url
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to create share link'
      });
    }
  });

  router.get('/shares/:id', (req, res) => {
    const share = registries.shares.get(req.params.id);
    if (!share) {
      return res.status(404).json({ success: false, message: 'Share link not found' });
    }

    res.json({ success: true, share: publicShare(share) });
  });

  function validateDownload(req, res) {
    const cid = String(req.query.cid || '').trim();
    const shareId = String(req.query.sid || req.query.shareId || '').trim();
    const mid = req.query.mid ? String(req.query.mid) : null;

    if (!isValidCid(cid)) {
      res.status(400).json({ success: false, message: 'A valid cid query parameter is required.' });
      return null;
    }

    let share = null;
    let session = null;
    if (shareId) {
      share = registries.shares.get(shareId);
      if (!share) {
        res.status(404).json({ success: false, message: 'Share link not found' });
        return null;
      }
      if (share.cid !== cid) {
        res.status(403).json({ success: false, message: 'CID does not match this share link.' });
        return null;
      }
      if (share.mid && mid && share.mid !== mid) {
        res.status(403).json({ success: false, message: 'MID does not match this share link.' });
        return null;
      }
      if (share.expiresAt && Date.now() > Date.parse(share.expiresAt)) {
        res.status(410).json({ success: false, message: 'Share link has expired.' });
        return null;
      }

      session = getValidDownloadSession(registries, getDownloadToken(req, share.id), share);
      if (!session && share.maxDownloads !== null && share.maxDownloads !== undefined && share.downloadCount >= share.maxDownloads) {
        res.status(410).json({ success: false, message: 'Share link download limit has been reached.' });
        return null;
      }
      if (!session && !verifyPassword(req.query.password || req.headers['x-share-password'], share.passwordHash)) {
        res.status(401).json({ success: false, message: 'Password required or invalid.', passwordRequired: true });
        return null;
      }
    }

    if (share && req.method === 'GET' && !session && req.query.redirect !== 'false') {
      share = registries.shares.update(share.id, (current) => ({
        ...current,
        downloadCount: (current?.downloadCount || 0) + 1,
        lastDownloadedAt: new Date().toISOString()
      }));
      session = createDownloadSession(registries, share);
      setDownloadSessionHeaders(res, share, session);
    } else if (share && session) {
      setDownloadSessionHeaders(res, share, session);
    }

    return { cid, mid, share, session };
  }

  function handleDownload(req, res) {
    const validation = validateDownload(req, res);
    if (!validation) {
      return;
    }

    const { cid, mid, share } = validation;
    const gatewayUrl = buildGatewayUrl(cid);
    if (req.query.redirect === 'false') {
      return res.json({
        success: true,
        cid,
        mid,
        sutro: req.query.sutro || share?.sutro || null,
        url: gatewayUrl,
        share: publicShare(share)
      });
    }

    const localRecord = findLocalFileByCid(registries, cid);
    if (localRecord && req.query.source !== 'gateway') {
      return sendLocalFile(localRecord, req, res);
    }

    if (req.query.proxy === 'true' || process.env.SHARE_GATEWAY_FALLBACK === 'proxy') {
      return proxyGateway(gatewayUrl, req, res);
    }

    res.redirect(302, gatewayUrl);
  }

  router.get('/download', handleDownload);
  router.head('/download', handleDownload);

  return router;
}

module.exports = createShareRoutes;
