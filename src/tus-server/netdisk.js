const express = require('express');
const router = express.Router();
const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const tusDataDir = process.env.NET_DISK;

// Helper function to determine content type
function getContentType(filename) {
    const contentType = mime.lookup(filename);
    return contentType || 'application/octet-stream';
}

// API endpoint to get directory contents
router.get('/netd', async (req, res) => {
    try {
        const currentPath = req.query.path || '';
        const directoryPath = path.join(tusDataDir, currentPath);
        
        // Security check to prevent directory traversal
        if (!directoryPath.startsWith(path.resolve(tusDataDir))) {
            return res.status(403).json({ error: 'Access denied: Invalid path' });
        }
        
        const files = await fsPromises.readdir(directoryPath);
        const fileList = [];

        for (const file of files) {
            // Ignore hidden files
            if (file.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(directoryPath, file);
            const relativePath = path.join(currentPath, file);
            
            try {
                const stat = await fsPromises.stat(fullPath);
                
                fileList.push({
                    name: file,
                    path: relativePath,
                    isDirectory: stat.isDirectory(),
                    size: stat.size,
                    modified: stat.mtime,
                });
            } catch (err) {
                console.error(`Error accessing ${file}:`, err);
                // Skip files that can't be accessed
            }
        }

        // Sort: directories first, then files alphabetically
        fileList.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({
            currentPath,
            parentPath: currentPath ? path.dirname(currentPath) : null,
            files: fileList
        });
    } catch (err) {
        console.error('Error reading directory:', err);
        res.status(500).json({ error: 'Failed to read directory' });
    }
});

// Endpoint to serve files
router.get('/netd/:filepath(*)', async (req, res) => {
    try {
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

        // Encode the filename for Content-Disposition
        const encodedFilename = encodeURIComponent(filename);

        // Set disposition based on download parameter
        let disposition = isDownload 
            ? `attachment; filename*=UTF-8''${encodedFilename}` 
            : `inline; filename*=UTF-8''${encodedFilename}`;

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

// Serve the Vue app for any netd route
router.get('/netd*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

module.exports = router;