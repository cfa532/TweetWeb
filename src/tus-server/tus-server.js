const express = require('express');
const router = express.Router();
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs');
const { url } = require('inspector');

// Set up tus server for resumable uploads
// const uploadPath = path.resolve(__dirname, './uploads');
const uploadPath = fs.realpathSync(path.resolve(__dirname, './uploads'));

// Ensure upload directory exists
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

// Create FileStore instance
const fileStore = new FileStore({
  directory: uploadPath
});

// Create tus server instance with required options
const tusServer = new Server({
  path: '/upload',
  datastore: fileStore,
  respectForwardedHeaders: true
});

// Handle base upload path (for POST requests to create uploads)
router.all('/upload', (req, res) => {
  console.log(`Received ${req.method} request to ${req.url}`);
  tusServer.handle(req, res);
});

// Handle upload paths with IDs (for PATCH requests to upload chunks)
router.all('/upload/*', (req, res) => {
  console.log(`Received ${req.method} request to ${req.url}`);
  tusServer.handle(req, res);
});

// Register a completed upload
router.post('/files/register', async (req, res) => {
  try {
    const { uploadUrl } = req.body;
    const uploadId = path.basename(uploadUrl);

    // Construct the full path to the uploaded file
    const uploadedFilePath = path.join(uploadPath, uploadId);

    // Check if the file exists
    // if (!fs.existsSync(uploadedFilePath)) {
    //   console.warn(`File not found: ${uploadedFilePath}`);
    //   return res.status(404).json({ error: 'File not found' });
    // }

    // Get file stats (size, etc.)
    const stats = fs.statSync(uploadedFilePath);
    const fileSize = stats.size;

    // Read metadata from the request
    const filename = req.body.filename || 'unknown';
    const filetype = req.body.filetype || 'application/octet-stream';

    // Generate a unique file ID
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    const permanentFilePath = path.join(uploadPath, `${fileId}${path.extname(filename)}`);

    // Rename the file to its permanent location
    fs.renameSync(uploadedFilePath, permanentFilePath);
    console.log(`File registered: ${fileId} ${filename} ${fileSize} ${url}`);

    // Return the file ID to the client
    res.status(201).json({
      id: fileId,
      name: filename,
      size: fileSize,
      type: filetype,
      createdAt: Date.now(),
      url: `/files/${fileId}${path.extname(filename)}`
    });
  } catch (error) {
    console.error('Error registering file:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve the uploaded files
router.get('/files/:fileId', (req, res) => {
  const { fileId } = req.params;
  const filePath = path.join(uploadPath, fileId);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

module.exports = router;