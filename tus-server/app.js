/**
 * Main Application Server
 * This module sets up the Express server with TUS upload support, file browsing,
 * and network disk functionality. It includes authorization middleware and CORS configuration.
 */

require('dotenv').config()

const cors = require('cors');
const express = require('express');
const fileUpload = require('express-fileupload');
const uploadRouter = require('./uploadRoutes');
const fileBrowserRouter = require('./uploadedFilesBrowser');
const netdisk = require('./netdisk');
const videoRouter = require('./videoRoutes');
const app = express();

// Get the port from the environment variable, or default to 3000
const port = process.env.PORT || 3000;

/**
 * Authorization Middleware
 * Checks if the request is authorized based on username.
 * Handles different types of requests:
 * - Regular API requests (via query params, body, or headers)
 * - TUS upload requests (via upload-metadata header)
 * - Special cases for registration and PATCH requests
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
function checkAuthorizedUser(req, res, next) {
  // Skip authorization for the register endpoint
  if (req.path === '/files/register') {
    return next();
  }
  
  // Skip authorization for the video conversion endpoint and status checks
  if (req.path === '/convert-video' || req.path.startsWith('/convert-video/status/')) {
    return next();
  }
  
  // Skip authorization for PATCH requests to existing uploads
  if ((req.method === 'PATCH' || req.method === 'HEAD') && req.path.startsWith('/upload/')) {
    return next();
  }

  // Skip authorization for file access paths
  if (req.path.startsWith('/netd/') && req.path !== '/netd') {
    return next();
  }

  // Skip authorization for /netd if a path query parameter is present
  if (req.path === '/netd' && req.query.path) {
    return next();
  }
  
  // For TUS upload requests (POST to /upload), extract username from metadata
  if (req.method === 'POST' && req.path === '/upload' && req.headers['upload-metadata']) {
    try {
      const metadataStr = req.headers['upload-metadata'];
      console.log('Raw metadata:', metadataStr);
      
      const metadataPairs = metadataStr.split(',');
      let usernameFound = false;
      
      for (const pair of metadataPairs) {
        const parts = pair.split(' ');
        if (parts.length !== 2) continue;
        
        const key = parts[0];
        const encodedValue = parts[1];
        
        if (key === 'username') {
          usernameFound = true;
          // Decode the base64 value
          const username = Buffer.from(encodedValue, 'base64').toString('utf-8');
          console.log('Username from TUS metadata:', username);
          console.log('Expected username:', process.env.AUTHORIZED_USERNAME);
          
          if (username === process.env.AUTHORIZED_USERNAME) {
            req.username = username;
            return next();
          } else {
            console.log('Username mismatch');
            // Return a plain text error for TUS client
            return res.status(403).send('Authorization failed: Invalid username');
          }
        }
      }
      
      if (!usernameFound) {
        console.log('No username found in metadata');
        return res.status(403).send('Authorization failed: No username provided');
      }
    } catch (err) {
      console.error('Error parsing TUS metadata:', err);
      return res.status(400).send('Invalid metadata format');
    }
  }
  
  // For regular requests, check query params, body, or headers
  const loggedInUsername = req.query.username || req.body.username || req.headers['x-username'];
  console.log('Username from request:', loggedInUsername);
  
  // Check if the logged in user matches the authorized user from env
  if (!loggedInUsername || loggedInUsername !== process.env.AUTHORIZED_USERNAME) {
    return res.status(403).json({ success: false, message: 'You are not authorized to access this resource.'});
  }
  
  // Store username for downstream middleware
  req.username = loggedInUsername;
  next();
}

// Configure middleware
app.use(express.json());

// Configure file upload middleware with different limits for different routes
app.use((req, res, next) => {
  // Use 1GB limit for video conversion, 50MB for other routes
  const fileSizeLimit = req.path === '/convert-video' ? 1024 * 1024 * 1024 : 50 * 1024 * 1024;
  
  // Set longer timeout for video uploads
  if (req.path === '/convert-video') {
    req.setTimeout(6 * 60 * 60 * 1000); // 6 hours for video processing
    res.setTimeout(6 * 60 * 60 * 1000); // 6 hours for video processing
  }
  
  fileUpload({
    limits: { fileSize: fileSizeLimit },
    abortOnLimit: true,
    useTempFiles: true,
    tempFileDir: '/tmp/',
    debug: false,
    // Add response timeout for large files
    responseTimeout: req.path === '/convert-video' ? 6 * 60 * 60 * 1000 : 30000
  })(req, res, next);
});

// Configure CORS with specific settings for TUS protocol
app.use(cors({
  origin: '*', // Your frontend origin
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Tus-Resumable',
    'Upload-Length',
    'Upload-Metadata',
    'Upload-Offset',
    'Upload-Defer-Length',
    'x-username',
    'X-Username',  // Add both lowercase and uppercase versions
    'Accept',
    'Cache-Control',
    'Connection',
    'Keep-Alive'
  ],
  exposedHeaders: [
    'Location',
    'Tus-Resumable',
    'Upload-Offset',
    'Upload-Length',
    'x-username',
    'X-Username'
  ],
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Apply the authorization middleware to all routes
app.use(checkAuthorizedUser);

// Mount the routers
app.use('/', uploadRouter);     // TUS upload handling
app.use('/', fileBrowserRouter); // File browser interface
app.use('/', netdisk);          // Network disk functionality
app.use('/', videoRouter);       // Video routes

// Redirect root to file browser
app.get('/', (req, res) => {
  res.redirect('/files');
});

// Start the server
app.listen(port, '::', () => {
  console.log(`Server listening on port ${port}`);
  console.log(`File browser available at http://server-ip:${port}/files`);
  console.log(`IPv6 support enabled - listening on all interfaces`);
});