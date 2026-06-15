const express = require('express');
const router = express.Router();
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs');
const { createRegistries } = require('./fileRegistry');
const { addPathToIpfs } = require('./ipfsService');

// Set up tus server for resumable uploads
const uploadDir = path.resolve(__dirname, './uploads');
// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const uploadPath = fs.realpathSync(uploadDir);
const registries = createRegistries(uploadPath);
const configuredIpfsConcurrency = Number(process.env.IPFS_CONVERSION_CONCURRENCY || 2);
const maxConcurrentIpfsConversions = Number.isInteger(configuredIpfsConcurrency) && configuredIpfsConcurrency > 0
  ? configuredIpfsConcurrency
  : 2;
const ipfsConversionQueue = [];
const queuedIpfsConversions = new Set();
let activeIpfsConversions = 0;

// Create FileStore instance
const fileStore = new FileStore({ directory: uploadPath });

// Create tus server instance with required options
const tusServer = new Server({
  path: '/upload',
  datastore: fileStore,
  respectForwardedHeaders: true
});

// Add hooks to the tus server to log events
tusServer.on('POST', (req) => {
  console.log('TUS POST request received');
  console.log('Username from request:', req.username);
});

function sanitizeOriginalName(filename) {
  const basename = path.basename(String(filename || 'unknown'));
  return basename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'unknown';
}

function extractUploadId(uploadUrl) {
  if (!uploadUrl) {
    throw new Error('uploadUrl is required');
  }

  let uploadId;
  try {
    const parsed = new URL(uploadUrl);
    uploadId = path.basename(parsed.pathname);
  } catch (error) {
    uploadId = path.basename(String(uploadUrl).split('?')[0]);
  }

  if (!uploadId || uploadId === '.' || uploadId === '/') {
    throw new Error('uploadUrl does not contain an upload id');
  }
  return uploadId;
}

function enqueueIpfsConversion(fileId) {
  if (queuedIpfsConversions.has(fileId)) {
    return;
  }

  queuedIpfsConversions.add(fileId);
  ipfsConversionQueue.push(fileId);
  processIpfsConversionQueue();
}

function processIpfsConversionQueue() {
  while (activeIpfsConversions < maxConcurrentIpfsConversions && ipfsConversionQueue.length > 0) {
    const fileId = ipfsConversionQueue.shift();
    queuedIpfsConversions.delete(fileId);
    activeIpfsConversions += 1;

    runIpfsConversion(fileId)
      .catch((error) => {
        console.error(`[IPFS] Unexpected conversion queue error for ${fileId}:`, error);
      })
      .finally(() => {
        activeIpfsConversions -= 1;
        processIpfsConversionQueue();
      });
  }
}

function startIpfsConversion(fileId) {
  const record = registries.files.get(fileId);
  if (!record || record.ipfs?.status === 'ready' || record.ipfs?.status === 'processing') {
    return;
  }

  registries.files.set(fileId, {
    ...record,
    ipfs: {
      ...(record.ipfs || {}),
      status: 'queued',
      error: null,
      queuedAt: new Date().toISOString()
    }
  });

  enqueueIpfsConversion(fileId);
}

async function runIpfsConversion(fileId) {
  const record = registries.files.get(fileId);
  if (!record || record.ipfs?.status === 'ready') {
    return;
  }

  const processingRecord = registries.files.set(fileId, {
    ...record,
    ipfs: {
      ...(record.ipfs || {}),
      status: 'processing',
      error: null,
      startedAt: new Date().toISOString()
    }
  });

  try {
    console.log(`[IPFS] Adding uploaded file to IPFS: ${processingRecord.path}`);
    const cid = await addPathToIpfs(processingRecord.path);
    registries.files.set(fileId, {
      ...processingRecord,
      ipfs: {
        status: 'ready',
        cid,
        error: null,
        queuedAt: processingRecord.ipfs?.queuedAt,
        startedAt: processingRecord.ipfs?.startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString()
      }
    });
    console.log(`[IPFS] File ${fileId} ready with CID ${cid}`);
  } catch (error) {
    console.error(`[IPFS] Failed to add file ${fileId}:`, error);
    registries.files.set(fileId, {
      ...processingRecord,
      ipfs: {
        ...(processingRecord.ipfs || {}),
        status: 'failed',
        error: error.message || String(error),
        completedAt: new Date().toISOString()
      }
    });
  }
}

function resumePendingIpfsConversions() {
  const files = registries.files.read();
  let resumed = 0;
  for (const file of Object.values(files)) {
    if (!file || !file.id || !file.ipfs) {
      continue;
    }
    if (file.ipfs.status === 'queued' || file.ipfs.status === 'processing') {
      registries.files.set(file.id, {
        ...file,
        ipfs: {
          ...file.ipfs,
          status: 'queued',
          error: null,
          resumedAt: new Date().toISOString()
        }
      });
      enqueueIpfsConversion(file.id);
      resumed += 1;
    }
  }
  if (resumed > 0) {
    console.log(`[IPFS] Resumed ${resumed} pending conversion job(s)`);
  }
}

// Handle base upload path (for POST requests to create uploads)
router.all('/upload', (req, res) => {
  console.log(`Received ${req.method} request to ${req.url}`);
  // Username has already been verified by the middleware
  tusServer.handle(req, res);
});

// Handle upload paths with IDs (for PATCH requests to upload chunks)
router.all('/upload/*', (req, res) => {
  console.log(`Received ${req.method} request to ${req.url}`);
  // Username has already been verified by the middleware
  tusServer.handle(req, res);
});

// Register a completed upload
router.post('/files/register', async (req, res) => {
  try {
    const { uploadUrl, filename, filetype, mid, sutro } = req.body;
    let uploadId;
    try {
      uploadId = extractUploadId(uploadUrl);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    // Username has already been verified by the middleware
    console.log(`Processing file registration for user: ${req.username}`);
    console.log(`NET_DISK: ${process.env.NET_DISK}`); // Verify NET_DISK

    // Construct the full path to the uploaded file
    const uploadedFilePath = path.join(uploadPath, uploadId);

    // Check if the file exists
    if (!fs.existsSync(uploadedFilePath)) {
      console.warn(`File not found: ${uploadedFilePath}`);
      return res.status(404).json({ error: 'File not found' });
    }

    // Get file stats (size, etc.)
    const stats = fs.statSync(uploadedFilePath);
    const fileSize = stats.size;

    // Extract the id from the uploadId (which is the tus upload's metadata.json id)
    const fileId = uploadId;
    const safeFilename = sanitizeOriginalName(filename);
    const fileExt = path.extname(safeFilename || '');
    const permanentFilePath = path.join(uploadPath, `${fileId}${fileExt}`);

    // Rename the file to its permanent location
    if (uploadedFilePath !== permanentFilePath) {
      if (fs.existsSync(permanentFilePath)) {
        fs.unlinkSync(permanentFilePath);
      }
      fs.renameSync(uploadedFilePath, permanentFilePath);
    }

    // Create symbolic link in NET_DISK directory if NET_DISK is defined
    if (process.env.NET_DISK) {
      // Ensure NET_DISK/uploads directory exists
      const netDiskUploadsPath = path.join(process.env.NET_DISK, 'uploads');
      if (!fs.existsSync(netDiskUploadsPath)) {
        try {
          fs.mkdirSync(netDiskUploadsPath, { recursive: true });
          console.log(`Created directory: ${netDiskUploadsPath}`);
        } catch (mkdirError) {
          console.error(`Error creating directory ${netDiskUploadsPath}:`, mkdirError);
          return res.status(500).json({ error: 'Could not create directory' }); // Stop if directory creation fails
        }
      }

      // Check if filename is valid
      if (!safeFilename) {
        console.warn('Filename is missing. Skipping symbolic link creation.');
      } else {
        // Create symbolic link using the original filename
        const symlinkPath = path.join(netDiskUploadsPath, safeFilename);

        // Remove existing symlink if it exists
        if (fs.existsSync(symlinkPath)) {
          try {
            fs.unlinkSync(symlinkPath);
            console.log(`Removed existing symlink: ${symlinkPath}`);
          } catch (unlinkError) {
            console.error(`Error removing existing symlink ${symlinkPath}:`, unlinkError);
          }
        }
        const permanentFilePath = path.join(uploadPath, `${fileId}${fileExt}`);

        // Create the symbolic link
        try {
          fs.symlinkSync(permanentFilePath, symlinkPath);
          console.log(`Created symbolic link: ${symlinkPath} -> ${permanentFilePath}`);
        } catch (error) {
          console.error(`Error creating symbolic link: ${error}`);
        }
      }
    } else {
      console.warn(
        'NET_DISK environment variable not set. Skipping symbolic link creation.'
      );
    }

    const record = registries.files.set(fileId, {
      id: fileId,
      name: safeFilename,
      type: filetype || 'application/octet-stream',
      size: fileSize,
      path: permanentFilePath,
      url: `/files/${fileId}${fileExt}`,
      mid: mid || null,
      sutro: sutro === undefined ? null : sutro,
      createdAt: new Date().toISOString(),
      ipfs: {
        status: 'queued',
        cid: null,
        error: null
      }
    });

    startIpfsConversion(fileId);

    console.log(`File registered: ${safeFilename} ${fileSize} ${fileId}`);

    // Return the file ID to the client
    res.status(201).json({
      id: fileId,
      name: safeFilename,
      size: fileSize,
      type: filetype || 'application/octet-stream',
      createdAt: Date.now(),
      url: `/files/${fileId}${fileExt}`,
      ipfs: record.ipfs
    });
  } catch (error) {
    console.error('Error registering file:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.uploadPath = uploadPath;
module.exports.registries = registries;
module.exports.startIpfsConversion = startIpfsConversion;
module.exports.resumePendingIpfsConversions = resumePendingIpfsConversions;
