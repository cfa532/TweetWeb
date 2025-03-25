require('dotenv').config()
const express = require('express');
const tusRouter = require('./tus-router'); // Assuming your tus routes are in tus-router.js
const app = express();

// Get the port from the environment variable, or default to 3000
const port = process.env.PORT || 3000;

// Middleware (e.g., for parsing JSON)
app.use(express.json());

// Use the tus router
app.use('/', tusRouter); // Mount the tus router at the root path

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});