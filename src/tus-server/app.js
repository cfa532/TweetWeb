require('dotenv').config()
const cors = require('cors');
const express = require('express');
const uploadRouter = require('./uploadRoutes');
const fileBrowserRouter = require('./fileBrowser');
const app = express();

// Get the port from the environment variable, or default to 3000
const port = process.env.PORT || 3000;

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

// Use the routers
app.use('/', uploadRouter); // Mount the upload router
app.use('/', fileBrowserRouter); // Mount the file browser router

// Redirect root to file browser
app.get('/', (req, res) => {
  res.redirect('/files');
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
  console.log(`File browser available at http://localhost:${port}/files`);
});