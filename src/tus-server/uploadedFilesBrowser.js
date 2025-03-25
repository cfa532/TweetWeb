const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { uploadPath } = require('./uploadRoutes');

// Helper functions for formatting
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
  else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
  else return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatDate(date) {
  return new Date(date).toLocaleString();
}

// Get content type based on file extension
function getContentType(filename, metadata) {
  if (metadata && metadata.filetype) {
    return metadata.filetype;
  }
  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.zip': 'application/zip'
  };
  return contentTypes[ext] || 'application/octet-stream';
}

// File browser functionality
router.get('/files', (req, res) => {
  // Normalize and sanitize the requested path
  const requestPath = (req.query.path || '').replace(/\.\./g, '');
  const currentPath = path.resolve(uploadPath, requestPath);

  // Security check to prevent directory traversal
  if (!currentPath.startsWith(path.resolve(uploadPath))) {
    return res.status(403).send('Access denied: Invalid path');
  }

  try {
    const stats = fs.statSync(currentPath);
    if (stats.isDirectory()) {
      // List directory contents
      const items = fs.readdirSync(currentPath);
      
      // Create a map of file IDs to their metadata
      const metadataMap = {};
      items.forEach(item => {
        if (item.endsWith('.json')) {
          try {
            const fileId = item.replace('.json', '');
            const metadata = JSON.parse(fs.readFileSync(path.join(currentPath, item), 'utf8'));
            metadataMap[fileId] = metadata;
          } catch (err) {
            console.error(`Error reading metadata for ${item}:`, err);
          }
        }
      });

      // Filter and map files
      const fileList = items
        .filter(item => {
          // Skip metadata files and other system files
          return !item.endsWith('.json') && !item.startsWith('.');
        })
        .map(item => {
          const itemPath = path.join(currentPath, item);
          const itemStats = fs.statSync(itemPath);
          const isDirectory = itemStats.isDirectory();
          
          // Get original filename from metadata if available
          let displayName = item;
          let fileMetadata = null;
          if (!isDirectory) {
            const fileId = item.split('.')[0]; // Get the file ID part
            if (metadataMap[fileId]) {
              fileMetadata = metadataMap[fileId].metadata;
              if (metadataMap[fileId].metadata && metadataMap[fileId].metadata.filename) {
                displayName = metadataMap[fileId].metadata.filename;
              }
            }
          }
          
          // Calculate relative path for URL
          const relativePath = path.relative(uploadPath, itemPath);
          const encodedRelativePath = encodeURIComponent(relativePath.replace(/\\/g, '/')); // Encode the relative path

          return {
            name: displayName,
            systemName: item,
            isDirectory,
            size: isDirectory ? null : itemStats.size,
            modified: itemStats.mtime,
            metadata: fileMetadata,
            // For directory links, use the query parameter approach
            url: isDirectory
              ? `/files?path=${encodeURIComponent(path.join(requestPath, item).replace(/\\/g, '/'))}`
              // For file links, use the direct file path approach
              : `/files/${encodedRelativePath}` // Use the encoded relative path here
          };
        });

      // Sort: directories first, then files alphabetically
      fileList.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // Calculate parent directory path for the 'up' link
      const parentPath = path.dirname(requestPath);
      const parentUrl = parentPath === '.' ? '/files' : `/files?path=${encodeURIComponent(parentPath.replace(/\\/g, '/'))}`;

      // Render directory listing
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>File Browser - ${requestPath || 'Root'}</title>
          <meta charset="UTF-8">
          <meta name='viewport' content='width=device-width, initial-scale=1'>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #333; }
            h1 { margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 10px; }
            .breadcrumb { margin-bottom: 20px; background-color: #f8f9fa; padding: 8px 15px; border-radius: 4px; }
            .breadcrumb a { color: #007bff; text-decoration: none; }
            .breadcrumb a:hover { text-decoration: underline; }
            .file-list { width: 100%; border-collapse: collapse; }
            .file-list th, .file-list td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #ddd; }
            .file-list th { background-color: #f8f9fa; font-weight: bold; }
            .file-list tr:hover { background-color: #f5f5f5; }
            .folder-icon, .file-icon { margin-right: 10px; }
            .folder-icon { color: #ffc107; }
            .file-icon { color: #6c757d; }
            .file-name { font-weight: 500; }
            .file-size, .file-date { color: #6c757d; white-space: nowrap; }
            .file-actions { white-space: nowrap; }
            .file-actions a { margin-left: 10px; color: #007bff; text-decoration: none; }
            .file-actions a:hover { text-decoration: underline; }
            @media (max-width: 768px) { .file-date { display: none; } }
          </style>
        </head>
        <body>
          <h1>File Browser</h1>
          <div class='breadcrumb'>
            <a href='/files'>Root</a>
            ${requestPath.split('/').filter(Boolean).map((part, index, array) => {
              const pathSoFar = array.slice(0, index + 1).join('/');
              return ` / <a href='/files?path=${encodeURIComponent(pathSoFar)}'>${part}</a>`;
            }).join('')}
          </div>
          <table class='file-list'>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${requestPath ? `
                <tr>
                  <td>
                    <a href='${parentUrl}'>
                      <span class='folder-icon'>📁</span>
                      <span class='file-name'>..</span>
                    </a>
                  </td>
                  <td></td>
                  <td></td>
                  <td></td>
                </tr>
              ` : ''}
              ${fileList.map(item => `
                <tr>
                  <td>
                    <a href='${item.url}'>
                      <span class='${item.isDirectory ? 'folder-icon' : 'file-icon'}'>${item.isDirectory ? '📁' : '📄'}</span>
                      <span class='file-name'>${item.name}</span>
                    </a>
                  </td>
                  <td class='file-size'>${item.isDirectory ? '-' : formatFileSize(item.size)}</td>
                  <td class='file-date'>${formatDate(item.modified)}</td>
                  <td class='file-actions'>
                    ${!item.isDirectory ? `
                      <a href='${item.url}?download=true'>Download</a>
                      <a href='${item.url}' target='_blank'>View</a>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </body>
        </html>
      `);
    } else {
      // Handle single file view/download
      const filename = path.basename(currentPath);
      const stats = fs.statSync(currentPath);
      const isDownload = req.query.download === 'true';

      // Try to get metadata
      let displayName = filename;
      let fileMetadata = null;
      const fileId = filename.split('.')[0];
      const metadataPath = path.join(path.dirname(currentPath), `${fileId}.json`);

      if (fs.existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          fileMetadata = metadata.metadata;
          if (metadata.metadata && metadata.metadata.filename) {
            displayName = metadata.metadata.filename;
          }
        } catch (err) {
          console.error(`Error reading metadata for ${filename}:`, err);
        }
      }
      
      // Set appropriate headers
      res.setHeader('Content-Length', stats.size);

      // Encode the filename for Content-Disposition
      const encodedFilename = encodeURIComponent(displayName);

      if (isDownload) {
          res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);
      } else {
          res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedFilename}`);
      }
      
      // Set content type
      const contentType = getContentType(filename, fileMetadata);
      res.setHeader('Content-Type', contentType);
      
      // If not downloading, and it's a non-viewable file type, show a simple file viewer
      if (!isDownload && !contentType.startsWith('image/') && !contentType.startsWith('video/') && 
          !contentType.startsWith('audio/') && contentType !== 'application/pdf') {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>File: ${displayName}</title>
            <meta charset="UTF-8">
            <meta name='viewport' content='width=device-width, initial-scale=1'>
            <style>
              body { font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #333; }
              .file-container { max-width: 800px; margin: 0 auto; background-color: #f8f9fa; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
              .file-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #ddd; }
              .file-title { font-size: 24px; margin: 0; }
              .file-actions a { display: inline-block; padding: 8px 16px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px; margin-left: 10px; }
              .file-actions a:hover { background-color: #0069d9; }
              .file-info { margin-bottom: 20px; }
              .file-info p { margin: 5px 0; color: #6c757d; }
              .back-link { display: inline-block; margin-bottom: 20px; color: #007bff; text-decoration: none; }
              .back-link:hover { text-decoration: underline; }
            </style>
          </head>
          <body>
            <a href='/files?path=${encodeURIComponent(path.dirname(path.relative(uploadPath, currentPath)).replace(/\\/g, '/'))}' class='back-link'>← Back to folder</a>
            <div class='file-container'>
              <div class='file-header'>
                <h1 class='file-title'>${displayName}</h1>
                <div class='file-actions'>
                  <a href='${req.originalUrl}&download=true'>Download</a>
                </div>
              </div>
              <div class='file-info'>
                <p><strong>Size:</strong> ${formatFileSize(stats.size)}</p>
                <p><strong>Type:</strong> ${contentType}</p>
                <p><strong>Modified:</strong> ${formatDate(stats.mtime)}</p>
              </div>
              <p>This file cannot be previewed in the browser. Please download it to view its contents.</p>
            </div>
          </body>
          </html>
        `);
      }
      
      // Send the file
      fs.createReadStream(currentPath).pipe(res);
    }
  } catch (error) {
    console.error('Error accessing file/directory:', error);
    res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error - File Not Found</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #333; text-align: center; }
          h1 { color: #dc3545; }
          .error-container { max-width: 500px; margin: 50px auto; padding: 20px; background-color: #f8f9fa; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .back-link { display: inline-block; margin-top: 20px; color: #007bff; text-decoration: none; }
          .back-link:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class='error-container'>
          <h1>File Not Found</h1>
          <p>The file or directory you requested could not be found.</p>
          <a href='/files' class='back-link'>Go to Root Directory</a>
        </div>
      </body>
      </html>
    `);
  }
});

// Add this route after the '/files' route for direct file access
router.get('/files/:filepath(*)', (req, res) => {
  try {
    // Get the requested file path
    const filepath = req.params.filepath;
    const fullPath = path.join(uploadPath, filepath);
    
    // Security check to prevent directory traversal
    if (!fullPath.startsWith(path.resolve(uploadPath))) {
      return res.status(403).send('Access denied: Invalid path');
    }
    
    // Check if file exists
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).send('File not found');
    }
    
    const filename = path.basename(fullPath);
    const stats = fs.statSync(fullPath);
    const isDownload = req.query.download === 'true';

    // Try to get metadata
    let displayName = filename;
    let fileMetadata = null;
    const fileId = filename.split('.')[0];
    const metadataPath = path.join(path.dirname(fullPath), `${fileId}.json`);

    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        fileMetadata = metadata.metadata;
        if (metadata.metadata && metadata.metadata.filename) {
          displayName = metadata.metadata.filename;
        }
      } catch (err) {
        console.error(`Error reading metadata for ${filename}:`, err);
      }
    }
    
    // Set appropriate headers
    res.setHeader('Content-Length', stats.size);

    // Encode the filename for Content-Disposition
    const encodedFilename = encodeURIComponent(displayName);

    // Set disposition based on download parameter
    if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);
    } else {
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedFilename}`);
    }
    
    // Set content type
    const contentType = getContentType(filename, fileMetadata);
    res.setHeader('Content-Type', contentType);
    
    // Send the file
    fs.createReadStream(fullPath).pipe(res);
    
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).send('Error serving file');
  }
});

module.exports = router;