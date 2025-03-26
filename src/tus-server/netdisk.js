const express = require('express');
const router = express.Router();
const fsPromises = require('fs').promises; // Rename to avoid confusion
const fs = require('fs'); // Require the standard fs module
const path = require('path');
const mime = require('mime-types'); // For determining content type

const tusDataDir = process.env.NET_DISK;
const baseUrl = process.env.BASE_URL || ''; // Add a base URL for your application

// Helper function to determine content type
function getContentType(filename) {
    const contentType = mime.lookup(filename);
    return contentType || 'application/octet-stream';
}

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to format date
function formatDate(date) {
    return new Date(date).toLocaleString();
}

// Helper function to generate HTML for file/directory listing
async function generateFileListHTML(directoryPath, currentPath = '') {
    try {
        const files = await fsPromises.readdir(directoryPath);
        const fileList = [];

        for (const file of files) {
            // Ignore hidden files
            if (file.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(directoryPath, file);
            const relativePath = path.join(currentPath, file);
            const stat = await fsPromises.stat(fullPath);

            // Encode the file name for URLs
            const encodedFile = encodeURIComponent(file);

            if (stat.isDirectory()) {
                fileList.push({
                    name: file,
                    url: `${baseUrl}/netd?path=${encodeURIComponent(relativePath)}`,
                    isDirectory: true,
                    modified: stat.mtime,
                    relativePath: relativePath // Store relative path for share functionality
                });
            } else {
                fileList.push({
                    name: file,
                    url: `${baseUrl}/netd/${encodeURIComponent(relativePath)}`,
                    isDirectory: false,
                    size: stat.size,
                    modified: stat.mtime,
                    relativePath: relativePath // Store relative path for share functionality
                });
            }
        }

        const parentUrl = currentPath ? `${baseUrl}/netd?path=${encodeURIComponent(path.dirname(currentPath))}` : '';
        const requestPath = currentPath;

        return `
        <!DOCTYPE html>
        <html>
        <head>
          <title>File Browser - ${requestPath || 'Root'}</title>
          <meta charset='UTF-8'>
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
            <a href='${baseUrl}/netd'>Root</a>
            ${requestPath.split('/').filter(Boolean).map((part, index, array) => {
              const pathSoFar = array.slice(0, index + 1).join('/');
              return ` / <a href='${baseUrl}/netd?path=${encodeURIComponent(pathSoFar)}'>${part}</a>`;
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
                      <a href='#' onclick='shareFile("${item.relativePath}", ${item.isDirectory})'>Share</a>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <script>
            function shareFile(relativePath, isDirectory) {
              // Implement your share functionality here
              // You can use relativePath and isDirectory to determine what to share
              alert('Share ' + relativePath + (isDirectory ? ' (Directory)' : ' (File)'));
            }
          </script>
        </body>
        </html>
      `;
    } catch (err) {
        console.error(err);
        return `<p>Failed to read files: ${err.message}</p>`;
    }
}

// Endpoint to list files and directories in the Tus data directory
router.get('/netd', async (req, res) => {
    const currentPath = req.query.path || '';
    const directoryPath = path.join(tusDataDir, currentPath);

    try {
        const html = await generateFileListHTML(directoryPath, currentPath);
        res.send(html);
    } catch (err) {
        console.error(err);
        res.status(500).send(`<h1>Error</h1><p>Failed to read files: ${err.message}</p>`);
    }
});

router.get('/netd/:filepath(*)', async (req, res) => {
    try {
        // Get the requested file path
        let filepath = req.params.filepath;
        const fullPath = path.join(tusDataDir, filepath);

        // Security check to prevent directory traversal
        if (!fullPath.startsWith(path.resolve(tusDataDir))) {
            return res.status(403).send('Access denied: Invalid path');
        }

        // Check if file exists
        try {
            await fsPromises.access(fullPath);
        } catch (err) {
            return res.status(404).send('File not found');
        }

        const stats = await fsPromises.stat(fullPath);
        if (!stats.isFile()) {
            return res.status(400).send('Not a file');
        }

        const filename = path.basename(fullPath);
        const isDownload = req.query.download === 'true';

        // Set appropriate headers
        //res.setHeader('Content-Length', stats.size);  // Remove this line

        // Encode the filename for Content-Disposition
        const encodedFilename = encodeURIComponent(filename);

        // Set disposition based on download parameter
        let disposition = isDownload ? `attachment; filename*=UTF-8''${encodedFilename}` : `inline; filename*=UTF-8''${encodedFilename}`;

        // Set content type
        const contentType = getContentType(filename);

        // Handle byte-range requests
        const range = req.headers.range;

        if (range) {
            // Parse the range header
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
            const chunksize = (end - start) + 1;

            // Create the stream with the specified range
            const fileStream = fs.createReadStream(fullPath, { start, end });

            // Set the appropriate headers
            res.status(206); // Partial Content
            res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', chunksize);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', disposition);

            // Pipe the stream to the response
            fileStream.pipe(res);

            fileStream.on('error', (streamError) => {
                console.error('Error streaming file:', streamError);
                res.status(500).send('Error streaming file');
            });

        } else {
            // No range requested -- serve the entire file
            res.setHeader('Content-Length', stats.size);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', disposition);

            const fileStream = fs.createReadStream(fullPath);
            fileStream.pipe(res);

            fileStream.on('error', (streamError) => {
                console.error('Error streaming file:', streamError);
                res.status(500).send('Error streaming file');
            });
        }

    } catch (error) {
        console.error('Error serving file:', error);
        res.status(500).send('Error serving file');
    }
});

module.exports = router;