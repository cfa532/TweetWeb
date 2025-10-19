const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const { getLeitherPort } = require('./leitherDetector');

// Concurrency management
let activeUploads = 0;
const maxConcurrentUploads = 3;
const uploadQueue = [];
let isProcessingQueue = false;

// Leither connection management is now handled in app.js

// Helper function to manage upload concurrency
function processUploadQueue() {
  if (isProcessingQueue || uploadQueue.length === 0 || activeUploads >= maxConcurrentUploads) {
    return;
  }
  
  isProcessingQueue = true;
  
  while (uploadQueue.length > 0 && activeUploads < maxConcurrentUploads) {
    const { req, res, resolve, reject } = uploadQueue.shift();
    activeUploads++;
    
    console.log(`[CONCURRENCY] Starting zip upload ${activeUploads}/${maxConcurrentUploads}. Queue length: ${uploadQueue.length}`);
    
    processZipUpload(req, res)
      .then(result => {
        activeUploads--;
        console.log(`[CONCURRENCY] Zip upload completed. Active: ${activeUploads}/${maxConcurrentUploads}`);
        resolve(result);
        processUploadQueue();
      })
      .catch(error => {
        activeUploads--;
        console.log(`[CONCURRENCY] Zip upload failed. Active: ${activeUploads}/${maxConcurrentUploads}`);
        reject(error);
        processUploadQueue();
      });
  }
  
  isProcessingQueue = false;
}

// Leither connection functions are now available globally from app.js

// Helper function to safely escape file paths for shell commands
function escapeShellArg(arg) {
  return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

// Helper function to cleanup old temporary files and directories
function cleanupOldTempFiles() {
  try {
    const tempDir = os.tmpdir();
    const files = fs.readdirSync(tempDir);
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    files.forEach(file => {
      if (file.startsWith('hls-zip-')) {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory() && stats.mtime.getTime() < oneHourAgo) {
          try {
            const isInUse = activeUploads > 0 && filePath.includes('hls-zip-');
            if (!isInUse) {
              fs.rmSync(filePath, { recursive: true, force: true });
              console.log(`[CLEANUP] Removed old temporary directory: ${filePath}`);
            } else {
              console.log(`[CLEANUP] Skipping directory in use: ${filePath}`);
            }
          } catch (cleanupError) {
            console.error(`[ERROR] Failed to cleanup old directory ${filePath}:`, cleanupError);
          }
        }
      }
    });
  } catch (error) {
    console.error('[ERROR] Failed to cleanup old temporary files:', error);
  }
}

// Helper function to find the actual HLS content directory
function findHLSContentDirectory(extractedPath, requestId) {
  console.log(`[${requestId}] [DEBUG] Finding HLS content directory in: ${extractedPath}`);
  
  // Check if HLS content is directly in the extracted path
  const masterPath = path.join(extractedPath, 'master.m3u8');
  if (fs.existsSync(masterPath)) {
    console.log(`[${requestId}] [DEBUG] HLS content found directly in extracted path`);
    return extractedPath;
  }
  
  // Check subdirectories for HLS content
  try {
    const subdirs = fs.readdirSync(extractedPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    console.log(`[${requestId}] [DEBUG] Checking subdirectories for HLS content: ${subdirs.join(', ')}`);
    
    for (const subdir of subdirs) {
      const subdirPath = path.join(extractedPath, subdir);
      
      // Check if this subdirectory contains master.m3u8
      const subdirMasterPath = path.join(subdirPath, 'master.m3u8');
      if (fs.existsSync(subdirMasterPath)) {
        console.log(`[${requestId}] [DEBUG] HLS content found in subdirectory: ${subdir}`);
        return subdirPath;
      }
      
      // Check if this subdirectory contains playlist.m3u8 files (quality directories)
      const subdirPlaylistPath = path.join(subdirPath, 'playlist.m3u8');
      if (fs.existsSync(subdirPlaylistPath)) {
        console.log(`[${requestId}] [DEBUG] HLS content found in subdirectory with playlist: ${subdir}`);
        return subdirPath;
      }
    }
  } catch (error) {
    console.error(`[${requestId}] [DEBUG] Error finding HLS content directory:`, error);
  }
  
  console.log(`[${requestId}] [DEBUG] No HLS content directory found`);
  return null;
}

// Helper function to validate HLS structure
function validateHLSStructure(extractedPath, requestId) {
  console.log(`[${requestId}] [DEBUG] Validating HLS structure in: ${extractedPath}`);
  
  // List all files and directories in the extracted path
  try {
    const allItems = fs.readdirSync(extractedPath, { withFileTypes: true });
    console.log(`[${requestId}] [DEBUG] Contents of extracted directory:`);
    allItems.forEach(item => {
      const itemPath = path.join(extractedPath, item.name);
      const type = item.isDirectory() ? '[DIR]' : '[FILE]';
      console.log(`[${requestId}] [DEBUG]   ${type} ${item.name}`);
    });
  } catch (error) {
    console.error(`[${requestId}] [DEBUG] Error reading extracted directory:`, error);
    return false;
  }
  
  // First, check if HLS content is directly in the extracted path
  const requiredFiles = ['master.m3u8'];
  const hasRequiredFiles = requiredFiles.some(file => {
    const filePath = path.join(extractedPath, file);
    const exists = fs.existsSync(filePath);
    console.log(`[${requestId}] [DEBUG] Checking for ${file}: ${exists ? 'FOUND' : 'NOT FOUND'}`);
    return exists;
  });
  
  if (hasRequiredFiles) {
    console.log(`[${requestId}] [DEBUG] Valid HLS structure found (master.m3u8 exists)`);
    return true;
  }
  
  console.log(`[${requestId}] [DEBUG] No master.m3u8 found in root, checking subdirectories...`);
  
  // Check for subdirectories that might contain playlists or HLS content
  const subdirs = fs.readdirSync(extractedPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
  
  console.log(`[${requestId}] [DEBUG] Found subdirectories: ${subdirs.join(', ')}`);
  
  for (const subdir of subdirs) {
    const subdirPath = path.join(extractedPath, subdir);
    
    // Check if this subdirectory contains a master.m3u8 (nested HLS structure)
    const masterPath = path.join(subdirPath, 'master.m3u8');
    const masterExists = fs.existsSync(masterPath);
    console.log(`[${requestId}] [DEBUG] Checking ${subdir}/master.m3u8: ${masterExists ? 'FOUND' : 'NOT FOUND'}`);
    
    if (masterExists) {
      console.log(`[${requestId}] [DEBUG] Valid HLS structure found (nested master.m3u8 in: ${subdir})`);
      return true;
    }
    
    // Check if this subdirectory contains playlist.m3u8 files (quality directories)
    const playlistPath = path.join(subdirPath, 'playlist.m3u8');
    const playlistExists = fs.existsSync(playlistPath);
    console.log(`[${requestId}] [DEBUG] Checking ${subdir}/playlist.m3u8: ${playlistExists ? 'FOUND' : 'NOT FOUND'}`);
    
    if (playlistExists) {
      console.log(`[${requestId}] [DEBUG] Valid HLS structure found (playlist in subdirectory: ${subdir})`);
      return true;
    }
    
    // Check if this subdirectory contains other subdirectories with playlists (nested structure)
    try {
      const nestedSubdirs = fs.readdirSync(subdirPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      
      if (nestedSubdirs.length > 0) {
        console.log(`[${requestId}] [DEBUG] Checking nested subdirectories in ${subdir}: ${nestedSubdirs.join(', ')}`);
        
        for (const nestedSubdir of nestedSubdirs) {
          const nestedPlaylistPath = path.join(subdirPath, nestedSubdir, 'playlist.m3u8');
          const nestedPlaylistExists = fs.existsSync(nestedPlaylistPath);
          console.log(`[${requestId}] [DEBUG] Checking ${subdir}/${nestedSubdir}/playlist.m3u8: ${nestedPlaylistExists ? 'FOUND' : 'NOT FOUND'}`);
          
          if (nestedPlaylistExists) {
            console.log(`[${requestId}] [DEBUG] Valid HLS structure found (nested playlist in: ${subdir}/${nestedSubdir})`);
            return true;
          }
        }
      }
    } catch (error) {
      console.log(`[${requestId}] [DEBUG] Error reading nested subdirectory ${subdir}:`, error.message);
    }
  }
  
  console.log(`[${requestId}] [DEBUG] No valid HLS structure found`);
  return false;
}

// Main zip processing function
async function processZipUpload(req, res) {
  const routeStartTime = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  console.log(`\n[${new Date().toISOString()}] [${requestId}] --- /process-zip route processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;
  let leitherClient = null;
  let hlsContentPath = null;
  
  // Set proper headers to keep connection alive
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=21600, max=1000'); // 6 hours timeout

  try {
    if (activeUploads <= 1) {
      console.log(`[${requestId}] [CLEANUP] Cleaning up old temporary files...`);
      cleanupOldTempFiles();
    }

    // Validate upload
    if (!req.files || !req.files.zipFile) {
      console.error(`[${requestId}] [ERROR] No zip file found in request. Expected a file with field name "zipFile".`);
      return res.status(400).json({
        success: false,
        message: 'No zip file uploaded. Please use the "zipFile" field name.'
      });
    }

    uploadedFile = req.files.zipFile;
    console.log(`[${requestId}] [INFO] Received zip: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);

    const maxFileSize = 500 * 1024 * 1024; // 500MB for zip files
    if (uploadedFile.size > maxFileSize) {
      console.error(`[${requestId}] [ERROR] File size ${uploadedFile.size} exceeds limit of ${maxFileSize}`);
      return res.status(400).json({
        success: false,
        message: `File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 500MB.`
      });
    }

    const allowedTypes = [
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream'
    ];
    
    // Allow zip files even if MIME type is not detected correctly
    const isZipFile = allowedTypes.includes(uploadedFile.mimetype) || 
                     uploadedFile.name.toLowerCase().endsWith('.zip');
    
    if (!isZipFile) {
      console.error(`[${requestId}] [ERROR] Unsupported file type: '${uploadedFile.mimetype}'.`);
      return res.status(400).json({
        success: false,
        message: `Invalid file type. Only ZIP files are allowed.`
      });
    }

    // Create temporary directory
    tempDir = path.join(os.tmpdir(), `hls-zip-${Date.now()}-${requestId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[${requestId}] [INFO] Created temporary directory: ${tempDir}`);

    // Extract zip file
    console.log(`\n[${requestId}] [STEP 1] Extracting zip file...`);
    console.time(`[${requestId}] zip-extraction`);
    
    try {
      const zip = new AdmZip(uploadedFile.tempFilePath);
      const extractedPath = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractedPath, { recursive: true });
      
      zip.extractAllTo(extractedPath, true);
      console.log(`[${requestId}] [SUCCESS] Zip file extracted successfully to: ${extractedPath}`);
      
      // Validate HLS structure
      console.log(`[${requestId}] [STEP 2] Validating HLS structure...`);
      if (!validateHLSStructure(extractedPath, requestId)) {
        console.error(`[${requestId}] [ERROR] Invalid HLS structure in zip file`);
        return res.status(400).json({
          success: false,
          message: 'Invalid HLS structure in zip file. Expected at least one playlist.m3u8 or master.m3u8 file.'
        });
      }
      
      console.log(`[${requestId}] [SUCCESS] HLS structure validated`);
      
      // Find the actual HLS content directory (might be nested)
      hlsContentPath = findHLSContentDirectory(extractedPath, requestId);
      if (!hlsContentPath) {
        console.error(`[${requestId}] [ERROR] Could not find HLS content directory`);
        return res.status(400).json({
          success: false,
          message: 'Could not locate HLS content in extracted ZIP file.'
        });
      }
      
      console.log(`[${requestId}] [INFO] HLS content found at: ${hlsContentPath}`);
      
    } catch (extractError) {
      console.error(`[${requestId}] [ERROR] Failed to extract zip file:`, extractError);
      return res.status(400).json({
        success: false,
        message: 'Failed to extract zip file. Please ensure it is a valid ZIP archive.'
      });
    }
    
    console.timeEnd(`[${requestId}] zip-extraction`);

    // Process with Leither
    console.log(`\n[${requestId}] [STEP 3] Processing with Leither service...`);
    console.time(`[${requestId}] leither-total-time`);
    let timingLabels = new Set();
    
    try {
      console.time(`[${requestId}] leither-port-detection`);
      timingLabels.add('leither-port-detection');
      const leitherPort = global.getCurrentLeitherPort();
      console.timeEnd(`[${requestId}] leither-port-detection`);
      timingLabels.delete('leither-port-detection');
      console.log(`[${requestId}] [INFO] Using Leither service on port: ${leitherPort}`);

      leitherClient = await global.getLeitherConnection();
      
      console.time(`[${requestId}] leither-get-ppt`);
      timingLabels.add('leither-get-ppt');
      console.log(`[${requestId}] [INFO] Getting PPT from Leither service...`);
      
      const executeLeitherOperation = async (operation, operationName, timeoutMs = 4 * 60 * 60 * 1000) => {
        try {
          console.log(`[${requestId}] [LEITHER] ${operationName}`);
          const result = await Promise.race([
            operation(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`${operationName} timeout after ${Math.round(timeoutMs / (60 * 1000))} minutes`)), timeoutMs)
            )
          ]);
          console.log(`[${requestId}] [LEITHER] ${operationName} completed successfully`);
          return result;
        } catch (error) {
          console.error(`[${requestId}] [LEITHER] ${operationName} failed:`, error.message);
          throw error;
        }
      };
      
      const leitherVersion = await executeLeitherOperation(
        () => leitherClient.Getvar("", "ver"),
        "Getvar version",
        30000 // 30 seconds for version check
      );
      console.log(`[${requestId}] [DEBUG] Leither version: ${leitherVersion}`);
      
      const ppt = await executeLeitherOperation(
        () => leitherClient.GetVarByContext("", "context_ppt", []),
        "GetVarByContext PPT",
        60000 // 1 minute for PPT retrieval
      );
      console.timeEnd(`[${requestId}] leither-get-ppt`);
      timingLabels.delete('leither-get-ppt');
      if (!ppt) throw new Error("Failed to get PPT from Leither service.");
      console.log(`[${requestId}] [SUCCESS] PPT received.`);

      console.time(`[${requestId}] leither-login`);
      timingLabels.add('leither-login');
      console.log(`[${requestId}] [INFO] Logging in to Leither service...`);
      const api = await executeLeitherOperation(
        () => leitherClient.Login(ppt),
        "Login",
        60000 // 1 minute for login
      );
      console.timeEnd(`[${requestId}] leither-login`);
      timingLabels.delete('leither-login');
      if (!api || !api.sid) throw new Error("Login to Leither service failed.");
      console.log(`[${requestId}] [SUCCESS] Login successful. SID:`, api.sid);

      console.time(`[${requestId}] leither-ipfs-add`);
      timingLabels.add('leither-ipfs-add');
      console.log(`[${requestId}] [INFO] Adding HLS content to IPFS from path: '${hlsContentPath}'`);

      const defaultTimeout = leitherClient.timeout;
      leitherClient.timeout = 0;
      const cid = await executeLeitherOperation(
        () => leitherClient.IpfsAdd(api.sid, hlsContentPath),
        "IpfsAdd",
        4 * 60 * 60 * 1000 // 4 hours for IPFS add (can be very large)
      );
      leitherClient.timeout = defaultTimeout;
      console.timeEnd(`[${requestId}] leither-ipfs-add`);
      timingLabels.delete('leither-ipfs-add');
      console.log(`[${requestId}] [SUCCESS] IPFS CID received:`, cid);

      console.timeEnd(`[${requestId}] leither-total-time`);
      timingLabels.delete('leither-total-time');
      
      // Send response with proper headers to ensure delivery
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(JSON.stringify({
        success: true,
        message: 'ZIP file extracted and HLS content added to IPFS successfully',
        cid: cid,
        tempDir: tempDir
      })));
      
      res.end(JSON.stringify({
        success: true,
        message: 'ZIP file extracted and HLS content added to IPFS successfully',
        cid: cid,
        tempDir: tempDir
      }));

    } catch (leitherError) {
      console.error(`[${requestId}] [FATAL] Leither service error:`, leitherError);
      
      // Clean up any active timing labels
      const labelsToClean = ['leither-total-time', 'leither-get-ppt', 'leither-login', 'leither-ipfs-add', 'leither-port-detection'];
      labelsToClean.forEach(label => {
        if (timingLabels.has(label)) {
          console.timeEnd(`[${requestId}] ${label}`);
          timingLabels.delete(label);
        }
      });
      
      let errorMessage = 'ZIP file extracted successfully, but Leither service failed';
      if (leitherError.message.includes('1006')) {
        errorMessage = 'ZIP file extracted successfully, but Leither service connection was lost (Error 1006). Please check if Leither service is running.';
      } else if (leitherError.message.includes('timeout')) {
        errorMessage = 'ZIP file extracted successfully, but Leither service operation timed out. The service may be overloaded.';
      } else if (leitherError.message.includes('WebSocket')) {
        errorMessage = 'ZIP file extracted successfully, but Leither service WebSocket connection failed. Please check network connectivity.';
      }
      
      // Send error response with proper headers
      const errorResponse = JSON.stringify({
        success: false,
        message: errorMessage,
        error: leitherError.message,
        tempDir: tempDir
      });
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(errorResponse));
      res.end(errorResponse);
    }

  } catch (error) {
    console.error(`[${requestId}] [FATAL] An unexpected error occurred in /process-zip route:`, error);

    // Send error response with proper headers
    const errorResponse = JSON.stringify({
      success: false,
      message: 'Failed to process ZIP file due to a server error.',
      error: error.message,
      tempDir: tempDir
    });
    
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', Buffer.byteLength(errorResponse));
    res.end(errorResponse);
  } finally {
    if (leitherClient) {
      global.releaseLeitherConnection(leitherClient);
    }
    
    if (uploadedFile && uploadedFile.tempFilePath && fs.existsSync(uploadedFile.tempFilePath)) {
      try {
        fs.unlinkSync(uploadedFile.tempFilePath);
        console.log(`[${requestId}] [CLEANUP] Removed temporary uploaded file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        console.error(`[${requestId}] [ERROR] Failed to cleanup uploaded file:`, cleanupError);
      }
    }
    
    console.log(`[${requestId}] [INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
    console.log(`[${requestId}] [INFO] Extracted HLS files preserved in: ${tempDir}`);
    console.log(`[${new Date().toISOString()}] [${requestId}] --- /process-zip route processing finished ---\n`);
  }
}

// Internal ZIP processing function (no response object)
async function processZipUploadInternal(req, jobId) {
  const routeStartTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] [${jobId}] --- /process-zip internal processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;
  let leitherClient = null;
  let hlsContentPath = null;

  try {
    if (activeUploads <= 1) {
      console.log(`[${jobId}] [CLEANUP] Cleaning up old temporary files...`);
      cleanupOldTempFiles();
    }

    // Validate upload
    if (!req.files || !req.files.zipFile) {
      console.error(`[${jobId}] [ERROR] No zip file found in request. Expected a file with field name "zipFile".`);
      throw new Error('No zip file uploaded. Please use the "zipFile" field name.');
    }

    uploadedFile = req.files.zipFile;
    console.log(`[${jobId}] [INFO] Received zip: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);

    const maxFileSize = 500 * 1024 * 1024; // 500MB for zip files
    if (uploadedFile.size > maxFileSize) {
      console.error(`[${jobId}] [ERROR] File size ${uploadedFile.size} exceeds limit of ${maxFileSize}`);
      throw new Error(`File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 500MB.`);
    }

    const allowedTypes = [
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream'
    ];
    
    // Allow zip files even if MIME type is not detected correctly
    const isZipFile = allowedTypes.includes(uploadedFile.mimetype) || 
                     uploadedFile.name.toLowerCase().endsWith('.zip');
    
    if (!isZipFile) {
      console.error(`[${jobId}] [ERROR] Unsupported file type: '${uploadedFile.mimetype}'.`);
      throw new Error(`Invalid file type. Only ZIP files are allowed.`);
    }

    // Create temporary directory
    tempDir = path.join(os.tmpdir(), `hls-zip-${Date.now()}-${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[${jobId}] [INFO] Created temporary directory: ${tempDir}`);

    // Update progress
    processingJobs.set(jobId, {
      ...processingJobs.get(jobId),
      progress: 20,
      message: 'Extracting ZIP file...'
    });

    // Extract zip file
    console.log(`\n[${jobId}] [STEP 1] Extracting zip file...`);
    console.time(`[${jobId}] zip-extraction`);
    
    try {
      const zip = new AdmZip(uploadedFile.tempFilePath);
      const extractedPath = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractedPath, { recursive: true });
      
      zip.extractAllTo(extractedPath, true);
      console.log(`[${jobId}] [SUCCESS] Zip file extracted successfully to: ${extractedPath}`);
      
      // Update progress
      processingJobs.set(jobId, {
        ...processingJobs.get(jobId),
        progress: 30,
        message: 'Validating HLS structure...'
      });
      
      // Validate HLS structure
      console.log(`[${jobId}] [STEP 2] Validating HLS structure...`);
      if (!validateHLSStructure(extractedPath, jobId)) {
        console.error(`[${jobId}] [ERROR] Invalid HLS structure in zip file`);
        throw new Error('Invalid HLS structure in zip file. Expected at least one playlist.m3u8 or master.m3u8 file.');
      }
      
      console.log(`[${jobId}] [SUCCESS] HLS structure validated`);
      
      // Find the actual HLS content directory (might be nested)
      hlsContentPath = findHLSContentDirectory(extractedPath, jobId);
      if (!hlsContentPath) {
        console.error(`[${jobId}] [ERROR] Could not find HLS content directory`);
        throw new Error('Could not locate HLS content in extracted ZIP file.');
      }
      
      console.log(`[${jobId}] [INFO] HLS content found at: ${hlsContentPath}`);
      
    } catch (extractError) {
      console.error(`[${jobId}] [ERROR] Failed to extract zip file:`, extractError);
      throw new Error('Failed to extract zip file. Please ensure it is a valid ZIP archive.');
    }
    
    console.timeEnd(`[${jobId}] zip-extraction`);

    // Process with Leither
    console.log(`\n[${jobId}] [STEP 3] Processing with Leither service...`);
    console.time(`[${jobId}] leither-total-time`);
    let timingLabels = new Set();
    
    // Update progress
    processingJobs.set(jobId, {
      ...processingJobs.get(jobId),
      progress: 40,
      message: 'Connecting to Leither service...'
    });
    
    try {
      console.time(`[${jobId}] leither-port-detection`);
      timingLabels.add('leither-port-detection');
      const leitherPort = global.getCurrentLeitherPort();
      console.timeEnd(`[${jobId}] leither-port-detection`);
      timingLabels.delete('leither-port-detection');
      console.log(`[${jobId}] [INFO] Using Leither service on port: ${leitherPort}`);

      leitherClient = await global.getLeitherConnection();
      
      console.time(`[${jobId}] leither-get-ppt`);
      timingLabels.add('leither-get-ppt');
      console.log(`[${jobId}] [INFO] Getting PPT from Leither service...`);
      
      const executeLeitherOperation = async (operation, operationName, timeoutMs = 4 * 60 * 60 * 1000) => {
        try {
          console.log(`[${jobId}] [LEITHER] ${operationName}`);
          const result = await Promise.race([
            operation(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`${operationName} timeout after ${Math.round(timeoutMs / (60 * 1000))} minutes`)), timeoutMs)
            )
          ]);
          console.log(`[${jobId}] [LEITHER] ${operationName} completed successfully`);
          return result;
        } catch (error) {
          console.error(`[${jobId}] [LEITHER] ${operationName} failed:`, error.message);
          throw error;
        }
      };
      
      const leitherVersion = await executeLeitherOperation(
        () => leitherClient.Getvar("", "ver"),
        "Getvar version",
        30000 // 30 seconds for version check
      );
      console.log(`[${jobId}] [DEBUG] Leither version: ${leitherVersion}`);
      
      const ppt = await executeLeitherOperation(
        () => leitherClient.GetVarByContext("", "context_ppt", []),
        "GetVarByContext PPT",
        60000 // 1 minute for PPT retrieval
      );
      console.timeEnd(`[${jobId}] leither-get-ppt`);
      timingLabels.delete('leither-get-ppt');
      if (!ppt) throw new Error("Failed to get PPT from Leither service.");
      console.log(`[${jobId}] [SUCCESS] PPT received.`);

      console.time(`[${jobId}] leither-login`);
      timingLabels.add('leither-login');
      console.log(`[${jobId}] [INFO] Logging in to Leither service...`);
      const api = await executeLeitherOperation(
        () => leitherClient.Login(ppt),
        "Login",
        60000 // 1 minute for login
      );
      console.timeEnd(`[${jobId}] leither-login`);
      timingLabels.delete('leither-login');
      if (!api || !api.sid) throw new Error("Login to Leither service failed.");
      console.log(`[${jobId}] [SUCCESS] Login successful. SID:`, api.sid);

      console.time(`[${jobId}] leither-ipfs-add`);
      timingLabels.add('leither-ipfs-add');
      console.log(`[${jobId}] [INFO] Adding HLS content to IPFS from path: '${hlsContentPath}'`);
      
      // Update progress
      processingJobs.set(jobId, {
        ...processingJobs.get(jobId),
        progress: 80,
        message: 'Adding to IPFS...'
      });

      const defaultTimeout = leitherClient.timeout;
      leitherClient.timeout = 0;
      const cid = await executeLeitherOperation(
        () => leitherClient.IpfsAdd(api.sid, hlsContentPath),
        "IpfsAdd",
        4 * 60 * 60 * 1000 // 4 hours for IPFS add (can be very large)
      );
      leitherClient.timeout = defaultTimeout;
      console.timeEnd(`[${jobId}] leither-ipfs-add`);
      timingLabels.delete('leither-ipfs-add');
      console.log(`[${jobId}] [SUCCESS] IPFS CID received:`, cid);

      console.timeEnd(`[${jobId}] leither-total-time`);
      timingLabels.delete('leither-total-time');
      
      return { cid, tempDir };

    } catch (leitherError) {
      console.error(`[${jobId}] [FATAL] Leither service error:`, leitherError);
      
      // Clean up any active timing labels
      const labelsToClean = ['leither-total-time', 'leither-get-ppt', 'leither-login', 'leither-ipfs-add', 'leither-port-detection'];
      labelsToClean.forEach(label => {
        if (timingLabels.has(label)) {
          console.timeEnd(`[${jobId}] ${label}`);
          timingLabels.delete(label);
        }
      });
      
      throw leitherError;
    }

  } catch (error) {
    console.error(`[${jobId}] [FATAL] An unexpected error occurred in /process-zip route:`, error);
    throw error;
  } finally {
    if (leitherClient) {
      global.releaseLeitherConnection(leitherClient);
    }
    
    if (uploadedFile && uploadedFile.tempFilePath && fs.existsSync(uploadedFile.tempFilePath)) {
      try {
        fs.unlinkSync(uploadedFile.tempFilePath);
        console.log(`[${jobId}] [CLEANUP] Removed temporary uploaded file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        console.error(`[${jobId}] [ERROR] Failed to cleanup uploaded file:`, cleanupError);
      }
    }
    
    console.log(`[${jobId}] [INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
    console.log(`[${jobId}] [INFO] Extracted HLS files preserved in: ${tempDir}`);
    console.log(`[${new Date().toISOString()}] [${jobId}] --- /process-zip route processing finished ---\n`);
  }
}

// Store for tracking ZIP processing status
const processingJobs = new Map();

// ZIP processing endpoint
router.post('/process-zip', async (req, res) => {
  // Set longer timeout for ZIP processing
  req.setTimeout(6 * 60 * 60 * 1000); // 6 hours
  res.setTimeout(6 * 60 * 60 * 1000); // 6 hours
  
  // Handle connection close gracefully
  req.on('close', () => {
    console.log('[PROCESS-ZIP] Client disconnected during upload');
  });
  
  req.on('error', (error) => {
    console.error('[PROCESS-ZIP] Request error:', error);
  });
  
  res.on('close', () => {
    console.log('[PROCESS-ZIP] Response closed');
  });
  
  // Generate a unique job ID
  const jobId = Math.random().toString(36).substr(2, 9);
  
  // Store job status
  processingJobs.set(jobId, {
    status: 'uploading',
    progress: 0,
    message: 'Starting ZIP upload...',
    startTime: Date.now()
  });
  
  // Send immediate response with job ID
  res.json({
    success: true,
    message: 'ZIP upload started',
    jobId: jobId
  });
  
  // Process ZIP in background
  processZipUploadAsync(req, jobId);
});

// Async ZIP processing function
async function processZipUploadAsync(req, jobId) {
  console.log(`[${jobId}] Starting background ZIP processing...`);
  
  try {
    // Update job status to processing
    processingJobs.set(jobId, {
      status: 'processing',
      progress: 10,
      message: 'Starting ZIP processing...',
      startTime: processingJobs.get(jobId).startTime
    });
    
    console.log(`[${jobId}] Calling processZipUploadInternal...`);
    
    // Process the ZIP (reuse existing logic)
    const result = await processZipUploadInternal(req, jobId);
    
    console.log(`[${jobId}] ZIP processing completed, CID:`, result.cid);
    
    // Update job status with success
    processingJobs.set(jobId, {
      status: 'completed',
      progress: 100,
      message: 'ZIP processing completed successfully',
      cid: result.cid,
      tempDir: result.tempDir,
      startTime: processingJobs.get(jobId).startTime,
      endTime: Date.now()
    });
    
  } catch (error) {
    console.error(`[${jobId}] Background processing failed:`, error);
    
    // Update job status with error
    processingJobs.set(jobId, {
      status: 'failed',
      progress: 0,
      message: error.message || 'ZIP processing failed',
      error: error.message,
      startTime: processingJobs.get(jobId).startTime,
      endTime: Date.now()
    });
  }
}

// Status check endpoint
router.get('/process-zip/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = processingJobs.get(jobId);
  
  console.log(`[${jobId}] Status check requested, current job:`, job ? {
    status: job.status,
    progress: job.progress,
    message: job.message
  } : 'Job not found');
  
  if (!job) {
    return res.status(404).json({
      success: false,
      message: 'Job not found'
    });
  }
  
  res.json({
    success: true,
    jobId: jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    cid: job.cid,
    tempDir: job.tempDir,
    startTime: job.startTime,
    endTime: job.endTime
  });
});

module.exports = router;
