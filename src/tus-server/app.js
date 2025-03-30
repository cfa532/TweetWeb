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
  // These are continuation requests for an already authorized upload
  if (req.method === 'PATCH' && req.path.startsWith('/upload/')) {
    return next();
  }

  // For TUS upload requests, extract username from metadata
  if (req.headers['upload-metadata']) {
    try {
      const metadataStr = req.headers['upload-metadata'];
      const metadataPairs = metadataStr.split(',');
      let username = '';
      
      for (const pair of metadataPairs) {
        const [key, value] = pair.split(' ');
        if (key === 'username') {
          // Decode the base64 value
          username = Buffer.from(value, 'base64').toString('utf-8');
          break;
        }
      }
      
      console.log('Username from TUS metadata:', username);
      if (username && username === process.env.AUTHORIZED_USERNAME) {
        req.username = username;
        return next();
      }
    } catch (err) {
      console.error('Error parsing TUS metadata:', err);
    }
  }

  // For regular requests, check query params, body, or headers
  const loggedInUsername = req.query.username || req.body.username || req.headers['x-username'];
  console.log('Username from request:', loggedInUsername);

  // Check if the logged in user matches the authorized user from env
  if (!loggedInUsername || loggedInUsername !== process.env.AUTHORIZED_USERNAME) {
    return res.status(403).json({ 
      success: false, 
      message: 'You are not authorized to access this resource' 
    });
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