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
  console.log('=== Extract-tar route called ===');
  console.log('Request headers:', req.headers);
  console.log('Request body keys:', Object.keys(req.body || {}));
  console.log('Request files:', req.files ? Object.keys(req.files) : 'No files');
  
  try {
    // Check if file was uploaded
    if (!req.files || !req.files.tarFile) {
      console.log('No tarFile found in request.files');
      return res.status(400).json({ 
        success: false, 
        message: 'No tar file uploaded. Please upload a file with the field name "tarFile".' 
      });
    }

    const uploadedFile = req.files.tarFile;
    console.log('Uploaded file details:', {
      name: uploadedFile.name,
      size: uploadedFile.size,
      mimetype: uploadedFile.mimetype,
      tempFilePath: uploadedFile.tempFilePath
    });
    
    // Validate file type
    const allowedTypes = ['application/x-tar', 'application/gzip', 'application/x-gzip'];
    if (!allowedTypes.includes(uploadedFile.mimetype)) {
      console.log('Invalid file type:', uploadedFile.mimetype);
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid file type. Please upload a tar or tar.gz file.' 
      });
    }

    // Create a unique temporary directory
    const tempDir = path.join(os.tmpdir(), `tar-extract-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    
    // Create the temporary directory
    fs.mkdirSync(tempDir, { recursive: true });
    
    console.log(`Created temporary directory: ${tempDir}`);
    console.log(`Extracting tar file: ${uploadedFile.name} (${uploadedFile.size} bytes)`);

    // Extract the tar file
    await tar.extract({
      file: uploadedFile.tempFilePath,
      cwd: tempDir,
      strip: 0 // Don't strip any directory levels
    });

    console.log(`Successfully extracted tar file to: ${tempDir}`);

    // Get Leither service port
    const leitherPort = await getLeitherPort();
    console.log(`Connecting to Leither service on port: ${leitherPort}`);

    // Create hprose client
    const client = hprose.HttpClient(`http://localhost:${leitherPort}/webapi/`);
    
    try {
      // Get sid from Leither service
      console.log('Getting ppt from Leither service...');
      const ppt = await client.GetVarByContext("", "context_ppt");
      console.log('PPT received:', ppt ? 'Yes' : 'No');
      
      // Login to get API access
      console.log('Logging in to Leither service...');
      const api = await client.Login(ppt);
      console.log('Login successful:', api ? 'Yes' : 'No');
      
      // Add the temporary directory to IPFS
      console.log('Adding temporary directory to IPFS...');
      const cid = await client.IpfsAdd(api, tempDir);
      console.log('IPFS CID received:', cid);
      
      // Return the CID to the caller
      res.json({
        success: true,
        message: 'Tar file extracted and added to IPFS successfully',
        extractedPath: tempDir,
        originalFileName: uploadedFile.name,
        extractedSize: uploadedFile.size,
        extractedAt: new Date().toISOString(),
        cid: cid,
        leitherPort: leitherPort
      });

    } catch (leitherError) {
      console.error('Leither service error:', leitherError);
      
      // Return the extracted path even if Leither fails
      res.json({
        success: true,
        message: 'Tar file extracted successfully, but Leither service failed',
        extractedPath: tempDir,
        originalFileName: uploadedFile.name,
        extractedSize: uploadedFile.size,
        extractedAt: new Date().toISOString(),
        leitherError: leitherError.message,
        leitherPort: leitherPort
      });
    }

  } catch (error) {
    console.error('Error extracting tar file:', error);
    
    // Clean up temporary directory if it was created
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`Cleaned up temporary directory: ${tempDir}`);
      } catch (cleanupError) {
        console.error('Error cleaning up temporary directory:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Failed to extract tar file',
      error: error.message
    });
  }
});

module.exports = router;
module.exports.uploadPath = uploadPath; 