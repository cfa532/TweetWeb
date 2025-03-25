const express = require('express');
const router = express.Router();
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const path = require('path');
const fs = require('fs');

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
    const { uploadUrl, filename, filetype } = req.body;
    const uploadId = path.basename(uploadUrl);
    
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
    
    // Generate a unique file ID
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    const fileExt = path.extname(filename || '');
    const permanentFilePath = path.join(uploadPath, `${fileId}${fileExt}`);
    
    // Rename the file to its permanent location
    fs.renameSync(uploadedFilePath, permanentFilePath);
    
    // Create metadata file with original filename
    const metadataFilePath = path.join(uploadPath, `${fileId}.metadata.json`);
    fs.writeFileSync(metadataFilePath, JSON.stringify({
      originalFilename: filename,
      contentType: filetype,
      uploadDate: new Date().toISOString(),
      size: fileSize
    }, null, 2));
    
    console.log(`File registered: ${fileId} ${filename} ${fileSize}`);
    
    // Return the file ID to the client
    res.status(201).json({
      id: fileId,
      name: filename || 'unknown',
      size: fileSize,
      type: filetype || 'application/octet-stream',
      createdAt: Date.now(),
      url: `/files/${fileId}${fileExt}`
    });
  } catch (error) {
    console.error('Error registering file:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.uploadPath = uploadPath;