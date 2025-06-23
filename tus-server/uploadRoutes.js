const express = require('express');
const router = express.Router();
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tar = require('tar');
const hprose = require('hprose');
const { getLeitherPort } = require('./leitherDetector');
const ayApi = ["GetVarByContext", "Act", "Login", "Getvar", "Getnodeip", "SwarmLocal", "DhtGetAllKeys","MFOpenByPath",
  "DhtGet", "DhtGets", "SignPPT", "RequestService", "SwarmAddrs", "MFOpenTempFile", "MFTemp2MacFile", "MFSetData",
  "MFGetData", "MMCreate", "MMOpen", "Hset", "Hget", "Hmset", "Hmget", "Zadd", "Zrangebyscore", "Zrange", "MFOpenMacFile",
  "MFReaddir", "MFGetMimeType", "MFSetObject", "MFGetObject", "Zcount", "Zrevrange", "Hlen", "Hscan", "Hrevscan",
  "MMRelease", "MMBackup", "MFStat", "Zrem", "Zremrangebyscore", "MiMeiPublish", "PullMsg", "MFTemp2Ipfs", "MFSetCid",
  "MMSum", "MiMeiSync", "IpfsAdd", "MMAddRef", "MMDelRef", "MMDelVers", "MMRelease", "MMGetRef", "MMGetRefs", "Hdel",
  "DhtFindPeer", "Logout", "MiMeiPublish", "MMSetRight"
];

// Set up tus server for resumable uploads
const uploadPath = fs.realpathSync(path.resolve(__dirname, './uploads'));
// Ensure upload directory exists
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

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
    const { uploadUrl, filename, filetype } = req.body;
    const uploadId = path.basename(uploadUrl);

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
    const fileExt = path.extname(filename || '');
    const permanentFilePath = path.join(uploadPath, `${fileId}${fileExt}`);

    // Rename the file to its permanent location
    fs.renameSync(uploadedFilePath, permanentFilePath);

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
      if (!filename) {
        console.warn('Filename is missing. Skipping symbolic link creation.');
        return; // Skip symlink creation if filename is missing
      }

      // Create symbolic link using the original filename
      const symlinkPath = path.join(netDiskUploadsPath, filename);

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
    } else {
      console.warn(
        'NET_DISK environment variable not set. Skipping symbolic link creation.'
      );
    }

    console.log(`File registered: ${filename} ${fileSize} ${fileId}`);

    // Return the file ID to the client
    res.status(201).json({
      id: fileId,
      name: filename || 'unknown',
      size: fileSize,
      type: filetype || 'application/octet-stream',
      createdAt: Date.now(),
      url: `/files/${fileId}${fileExt}`,
    });
  } catch (error) {
    console.error('Error registering file:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Extract tar file route with Leither integration
router.post('/extract-tar', async (req, res) => {
  const routeStartTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] --- /extract-tar route processing started ---`);

  try {
    // --- 1. VALIDATE UPLOAD ---
    console.log('[STEP 1] Validating uploaded file...');
    if (!req.files || !req.files.tarFile) {
      console.error('[ERROR] No file object found in request. Expected a file with field name "tarFile".');
      return res.status(400).json({
        success: false,
        message: 'No tar file uploaded. Please use the "tarFile" field name.'
      });
    }

    const uploadedFile = req.files.tarFile;
    console.log(`[INFO] Received file: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);
    console.log(`[DEBUG] File temporarily stored at: ${uploadedFile.tempFilePath}`);

    const allowedTypes = ['application/x-tar', 'application/gzip', 'application/x-gzip'];
    if (!allowedTypes.includes(uploadedFile.mimetype)) {
      console.error(`[ERROR] Unsupported file type: '${uploadedFile.mimetype}'.`);
      return res.status(400).json({
        success: false,
        message: `Invalid file type. Allowed types are: ${allowedTypes.join(', ')}`
      });
    }
    console.log('[SUCCESS] File validation complete.');

    // --- 2. EXTRACT TAR ARCHIVE ---
    console.log('\n[STEP 2] Extracting tar archive...');
    const tempDir = path.join(os.tmpdir(), `tar-extract-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[INFO] Created temporary directory: ${tempDir}`);
    
    console.time('tar-extraction');
    await tar.extract({
      file: uploadedFile.tempFilePath,
      cwd: tempDir,
      strip: 0 // Don't strip any directory levels
    });
    console.timeEnd('tar-extraction');
    console.log(`[SUCCESS] Tar file extracted to: ${tempDir}`);

    // --- 3. PROCESS WITH LEITHER ---
    console.log('\n[STEP 3] Processing with Leither service...');
    console.time('leither-total-time');
    let leitherPort;
    
    try {
      console.time('leither-port-detection');
      leitherPort = await getLeitherPort();
      console.timeEnd('leither-port-detection');
      console.log(`[INFO] Detected Leither service on port: ${leitherPort}`);

      const client = hprose.Client.create(`ws://127.0.0.1:${leitherPort}/ws/`, ayApi);
      console.log(`[INFO] Hprose client created for ws://127.0.0.1:${leitherPort}/ws/`);
      
      console.time('leither-get-ppt');
      console.log('[INFO] Getting PPT from Leither service...');
      console.log(`[DEBUG] Calling Getvar("", "ver")...`);
      const leitherVersion = await client.Getvar("", "ver");
      console.log(`[DEBUG] Leither version: ${leitherVersion}`);
      const ppt = await client.GetVarByContext("", "context_ppt", []);
      console.timeEnd('leither-get-ppt');
      if (!ppt) throw new Error("Failed to get PPT from Leither service.");
      console.log('[SUCCESS] PPT received.');

      console.time('leither-login');
      console.log('[INFO] Logging in to Leither service...');
      const api = await client.Login(ppt);
      console.timeEnd('leither-login');
      if (!api || !api.sid) throw new Error("Login to Leither service failed.");
      console.log('[SUCCESS] Login successful. SID:', api.sid);

      console.time('leither-ipfs-add');
      console.log(`[INFO] Adding content to IPFS from path: '${tempDir}'`);
      const cid = await client.IpfsAdd(api.sid, tempDir);
      console.timeEnd('leither-ipfs-add');
      console.log('[SUCCESS] IPFS CID received:', cid);

      console.timeEnd('leither-total-time');
      
      res.json({
        success: true,
        message: 'Tar file extracted and added to IPFS successfully',
        cid: cid,
      });

    } catch (leitherError) {
      console.error('[FATAL] Leither service error:', leitherError);
      console.timeEnd('leither-total-time');
      
      res.json({
        success: false,
        message: 'Tar file extracted successfully, but Leither service failed',
      });
    }

  } catch (error) {
    console.error('[FATAL] An unexpected error occurred in /extract-tar route:', error);
    
    // tempDir might not be defined if error is early, so check for it.
    if (typeof tempDir !== 'undefined' && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`[CLEANUP] Cleaned up temporary directory: ${tempDir}`);
      } catch (cleanupError) {
        console.error('[ERROR] Failed to cleanup temporary directory:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Failed to process tar file due to a server error.',
      error: error.message
    });
  } finally {
      console.log(`[INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
      console.log(`[${new Date().toISOString()}] --- /extract-tar route processing finished ---\n`);
  }
});

module.exports = router;
module.exports.uploadPath = uploadPath;