require('dotenv').config()
const cors = require('cors');
const express = require('express');
const uploadRouter = require('./uploadRoutes');
const fileBrowserRouter = require('./uploadedFilesBrowser');
const netdisk = require('./netdisk');
const app = express();

// Get the port from the environment variable, or default to 3000
const port = process.env.PORT || 3000;

function checkAuthorizedUser(req, res, next) {
  // Skip authorization for the register endpoint
  if (req.path === '/files/register') {
    return next();
  }
  
  // Skip authorization for PATCH requests to existing uploads
  if ((req.method === 'PATCH' || req.method === 'HEAD') && req.path.startsWith('/upload/')) {
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
    return res.status(403).json({ success: false, message: 'You are not authorized to access this resource' });
  }
  
  // Store username for downstream middleware
  req.username = loggedInUsername;
  next();
}

// Middleware
app.use(express.json());
app.use(cors({
  origin: '*', // Your frontend origin
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Tus-Resumable', 'Upload-Length', 'Upload-Metadata', 'Upload-Offset', 'Upload-Defer-Length'],
  exposedHeaders: ['Location', 'Tus-Resumable', 'Upload-Offset', 'Upload-Length'],
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Apply the authorization middleware to all routes
app.use(checkAuthorizedUser);

// Use the routers
app.use('/', uploadRouter); // Mount the upload router
app.use('/', fileBrowserRouter); // Mount the file browser router
app.use('/', netdisk);

// Redirect root to file browser
app.get('/', (req, res) => {
  res.redirect('/files');
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
  console.log(`File browser available at http://server-ip:${port}/files`);
});