/**
 * Main Application Server
 * This module sets up the Express server with TUS upload support, file browsing,
 * and network disk functionality. It includes authorization middleware and CORS configuration.
 */

require('dotenv').config()

const cors = require('cors');
const express = require('express');
const fileUpload = require('express-fileupload');
const hprose = require('hprose');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const uploadRouter = require('./uploadRoutes');
const fileBrowserRouter = require('./uploadedFilesBrowser');
const netdisk = require('./netdisk');
const videoRouter = require('./videoRoutes');
const zipRouter = require('./zipRoutes');
const { getLeitherPort } = require('./leitherDetector');
const app = express();

// Promisify exec for async/await usage
const execAsync = promisify(exec);

// Get the port from the environment variable, or default to 3000
const port = process.env.PORT || 3000;

// Leither connection management
let leitherConnections = new Map();
let leitherPort = null;
let leitherInitialized = false;
const maxLeitherConnections = 2;

// Hardware encoder detection cache
let hardwareEncoderCache = null;
let hardwareEncoderCacheTime = 0;
const HARDWARE_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours (much longer since we test at startup)
let hardwareInitialized = false;

// Leither API array for IPFS integration
const ayApi = ["GetVarByContext", "Act", "Login", "Getvar", "Getnodeip", "SwarmLocal", "DhtGetAllKeys","MFOpenByPath",
  "DhtGet", "DhtGets", "SignPPT", "RequestService", "SwarmAddrs", "MFOpenTempFile", "MFTemp2MacFile", "MFSetData",
  "MFGetData", "MMCreate", "MMOpen", "Hset", "Hget", "Hmset", "Hmget", "Zadd", "Zrangebyscore", "Zrange", "MFOpenMacFile",
  "MFReaddir", "MFGetMimeType", "MFSetObject", "MFGetObject", "Zcount", "Zrevrange", "Hlen", "Hscan", "Hrevscan",
  "MMRelease", "MMBackup", "MFStat", "Zrem", "Zremrangebyscore", "MiMeiPublish", "PullMsg", "MFTemp2Ipfs", "MFSetCid",
  "MMSum", "MiMeiSync", "IpfsAdd", "MMAddRef", "MMDelRef", "MMDelVers", "MMRelease", "MMGetRef", "MMGetRefs", "Hdel",
  "DhtFindPeer", "Logout", "MiMeiPublish", "MMSetRight"
];

/**
 * Initialize Leither connection on app startup
 */
async function initializeLeither() {
  if (leitherInitialized) {
    return;
  }
  
  try {
    console.log('[LEITHER-INIT] Initializing Leither connection...');
    leitherPort = await getLeitherPort();
    console.log(`[LEITHER-INIT] Detected Leither service on port: ${leitherPort}`);
    
    // Test connection by creating a client
    const testClient = await createLeitherClient(leitherPort);
    if (testClient) {
      console.log('[LEITHER-INIT] Leither connection test successful');
      leitherInitialized = true;
    }
  } catch (error) {
    console.error('[LEITHER-INIT] Failed to initialize Leither connection:', error.message);
    console.log('[LEITHER-INIT] Leither service may not be available, but app will continue');
    leitherInitialized = false;
  }
}

/**
 * Create a Leither client connection
 */
function createLeitherClient(port) {
  return new Promise((resolve, reject) => {
    try {
      console.log(`[LEITHER] Creating client connection to port ${port}`);
      
      const client = hprose.Client.create(`ws://127.0.0.1:${port}/ws/`, ayApi);
      client.timeout = 30000;
      
      if (client.connection) {
        client.connection.on('open', () => {
          console.log(`[LEITHER] WebSocket connection established to port ${port}`);
          resolve(client);
        });
        
        client.connection.on('close', (code, reason) => {
          console.log(`[LEITHER] WebSocket connection closed: code=${code}, reason=${reason}`);
          reject(new Error(`WebSocket connection closed: code=${code}, reason=${reason}`));
        });
        
        client.connection.on('error', (error) => {
          console.error(`[LEITHER] WebSocket connection error:`, error);
          reject(new Error(`WebSocket connection failed: ${error.message}`));
        });
      } else {
        resolve(client);
      }
      
    } catch (error) {
      console.error(`[LEITHER] Error creating client:`, error);
      reject(error);
    }
  });
}

/**
 * Get or create a Leither connection from the pool
 */
async function getLeitherConnection() {
  if (!leitherInitialized || !leitherPort) {
    throw new Error('Leither service not initialized');
  }
  
  const connectionKey = `port-${leitherPort}`;
  
  if (leitherConnections.has(connectionKey)) {
    const connection = leitherConnections.get(connectionKey);
    if (connection.isAvailable) {
      connection.isAvailable = false;
      return connection.client;
    }
  }
  
  if (leitherConnections.size < maxLeitherConnections) {
    const client = await createLeitherClient(leitherPort);
    leitherConnections.set(connectionKey, {
      client,
      isAvailable: false,
      port: leitherPort
    });
    return client;
  }
  
  return new Promise((resolve) => {
    const checkConnection = () => {
      for (const [key, conn] of leitherConnections) {
        if (conn.isAvailable) {
          conn.isAvailable = false;
          resolve(conn.client);
          return;
        }
      }
      setTimeout(checkConnection, 100);
    };
    checkConnection();
  });
}

/**
 * Release a Leither connection back to the pool
 */
function releaseLeitherConnection(client) {
  for (const [key, conn] of leitherConnections) {
    if (conn.client === client) {
      conn.isAvailable = true;
      break;
    }
  }
}

/**
 * Get the current Leither port
 */
function getCurrentLeitherPort() {
  return leitherPort;
}

/**
 * Check if Leither is initialized
 */
function isLeitherInitialized() {
  return leitherInitialized;
}

// Make leither functions available globally
global.getLeitherConnection = getLeitherConnection;
global.releaseLeitherConnection = releaseLeitherConnection;
global.getCurrentLeitherPort = getCurrentLeitherPort;
global.isLeitherInitialized = isLeitherInitialized;

/**
 * Helper function to safely escape file paths for shell commands
 */
function escapeShellArg(arg) {
  return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Helper function to get hardware-specific encoding parameters
 */
function getHardwareEncodingParams(encoder, is10Bit = false) {
  switch (encoder) {
    case 'h264_nvenc':
      return is10Bit ? '-rc vbr -cq 23 -b:v 0 -maxrate 5M -bufsize 10M -pix_fmt yuv420p10le' : '-rc vbr -cq 23 -b:v 0 -maxrate 5M -bufsize 10M';
    case 'h264_qsv':
      return is10Bit ? '-global_quality 23 -look_ahead 1 -pix_fmt yuv420p10le' : '-global_quality 23 -look_ahead 1';
    case 'h264_videotoolbox':
      // VideoToolbox optimized for Apple Silicon (M1/M2/M3/M4)
      // -allow_sw 1: Allow software fallback if needed
      // -q:v 65: Quality level (0-100, ~65 for good quality/size balance)
      // -realtime 0: Disable real-time encoding for better quality
      // -prio_speed 0: Prioritize quality over speed
      return is10Bit ? '-allow_sw 1 -q:v 65 -realtime 0 -prio_speed 0 -pix_fmt yuv420p10le' : '-allow_sw 1 -q:v 65 -realtime 0 -prio_speed 0';
    case 'h264_amf':
      return is10Bit ? '-rc cqp -qp_i 23 -qp_p 23 -pix_fmt yuv420p10le' : '-rc cqp -qp_i 23 -qp_p 23';
    default:
      return is10Bit ? '-pix_fmt yuv420p10le' : '';
  }
}

/**
 * Helper function to test if a hardware encoder actually works
 */
function testHardwareEncoder(encoder) {
  return new Promise((resolve) => {
    const testFile = path.join(os.tmpdir(), `encoder_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp4`);
    // Get encoder-specific parameters for testing
    let hwParams = getHardwareEncodingParams(encoder, false);
    // For VideoToolbox, add bitrate requirement for testing
    if (encoder === 'h264_videotoolbox') {
      hwParams += ' -b:v 2M';
    }
    const formattedHwParams = hwParams ? ` ${hwParams}` : '';
    const testCommand = `ffmpeg -f lavfi -i testsrc=duration=0.5:size=320x240:rate=1 -c:v ${encoder}${formattedHwParams} -t 0.5 ${escapeShellArg(testFile)} -y 2>&1`;
    console.log(`[HARDWARE] Testing encoder ${encoder} with command: ${testCommand}`);
    
    execAsync(testCommand, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 })
      .then(() => {
        // Clean up test file
        try {
          if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }
        console.log(`[HARDWARE] Encoder ${encoder} test passed`);
        resolve(true);
      })
      .catch((error) => {
        // Clean up test file on error too
        try {
          if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }
        console.log(`[HARDWARE] Encoder ${encoder} test failed:`, error.message);
        if (error.stdout && error.stdout.includes('Error')) {
          console.log(`[HARDWARE] Test stdout:`, error.stdout.substring(0, 500));
        }
        resolve(false);
      });
  });
}

/**
 * Initialize hardware encoder detection on app startup
 */
async function initializeHardwareEncoders() {
  if (hardwareInitialized) {
    return;
  }
  
  try {
    console.log('[HARDWARE-INIT] Detecting available hardware encoders...');
    
    // First, check which encoders are available in FFmpeg
    const command = 'ffmpeg -hide_banner -encoders 2>&1 | grep -E "(h264_nvenc|h264_qsv|h264_videotoolbox|h264_amf)" || true';
    const result = await execAsync(command, { timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
    const encoders = result.stdout.toLowerCase();
    
    const detected = {
      nvidia: encoders.includes('h264_nvenc'),
      intel: encoders.includes('h264_qsv'),
      apple: encoders.includes('h264_videotoolbox'),
      amd: encoders.includes('h264_amf')
    };
    
    console.log('[HARDWARE-INIT] Detected encoders:', detected);
    
    // Now test each detected encoder to see if it actually works
    const working = {
      nvidia: false,
      intel: false,
      apple: false,
      amd: false
    };
    
    if (detected.nvidia) {
      console.log('[HARDWARE-INIT] Testing NVIDIA encoder...');
      working.nvidia = await testHardwareEncoder('h264_nvenc');
    }
    
    if (detected.intel) {
      console.log('[HARDWARE-INIT] Testing Intel encoder...');
      working.intel = await testHardwareEncoder('h264_qsv');
    }
    
    if (detected.apple) {
      console.log('[HARDWARE-INIT] Testing Apple encoder...');
      working.apple = await testHardwareEncoder('h264_videotoolbox');
    }
    
    if (detected.amd) {
      console.log('[HARDWARE-INIT] Testing AMD encoder...');
      working.amd = await testHardwareEncoder('h264_amf');
    }
    
    // Cache the working encoders
    hardwareEncoderCache = working;
    hardwareEncoderCacheTime = Date.now();
    hardwareInitialized = true;
    
    const workingCount = Object.values(working).filter(v => v).length;
    if (workingCount > 0) {
      console.log(`[HARDWARE-INIT] Hardware encoding enabled with ${workingCount} encoder(s):`, working);
    } else {
      console.log('[HARDWARE-INIT] No working hardware encoders found, will use software encoding');
    }
    
  } catch (error) {
    console.error('[HARDWARE-INIT] Failed to initialize hardware encoder detection:', error.message);
    console.log('[HARDWARE-INIT] Will use software encoding');
    hardwareEncoderCache = { nvidia: false, intel: false, apple: false, amd: false };
    hardwareEncoderCacheTime = Date.now();
    hardwareInitialized = true;
  }
}

/**
 * Get available hardware encoders (from cache)
 */
function getAvailableHardwareEncoders() {
  if (hardwareEncoderCache && (Date.now() - hardwareEncoderCacheTime) < HARDWARE_CACHE_DURATION) {
    return hardwareEncoderCache;
  }
  // Fallback if cache expired
  return { nvidia: false, intel: false, apple: false, amd: false };
}

// Make hardware functions available globally
global.getAvailableHardwareEncoders = getAvailableHardwareEncoders;
global.getHardwareEncodingParams = getHardwareEncodingParams;

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
  // Skip authorization for the health check endpoint
  if (req.path === '/health') {
    return next();
  }
  
  // Skip authorization for the register endpoint
  if (req.path === '/files/register') {
    return next();
  }
  
  // Skip authorization for the video conversion endpoint and status checks
  if (req.path === '/convert-video' || req.path.startsWith('/convert-video/status/')) {
    return next();
  }
  
  // Skip authorization for the zip processing endpoint and status checks
  if (req.path === '/process-zip' || req.path.startsWith('/process-zip/status/')) {
    return next();
  }
  
  // Skip authorization for the video normalization endpoint and status checks
  if (req.path === '/normalize-video' || req.path.startsWith('/normalize-video/status/')) {
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

// Configure middleware with optimized settings
app.use(express.json({ limit: '50mb' }));

// Configure request body parsing for larger files
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Optimize server for faster uploads
app.use((req, res, next) => {
  // Set TCP_NODELAY to reduce latency
  if (req.socket) {
    req.socket.setNoDelay(true);
    // Increase TCP window size for better throughput
    req.socket.setKeepAlive(true, 60000); // 60 seconds
    req.socket.setTimeout(0); // No socket timeout
  }
  
  // Optimize for large file uploads
  if (req.path === '/convert-video' || req.path === '/process-zip') {
    // Set high water mark for better throughput
    if (req.socket) {
      req.socket.setKeepAlive(true, 60000);
      req.socket.setTimeout(0);
    }
    
    // Set response headers for better performance
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.setHeader('Cache-Control', 'no-cache');
  }
  
  next();
});

// Configure file upload middleware with different limits for different routes
app.use((req, res, next) => {
  // Use 1GB limit for video conversion, 500MB for zip processing, 50MB for other routes
  let fileSizeLimit = 50 * 1024 * 1024; // Default 50MB
  if (req.path === '/convert-video') {
    fileSizeLimit = 4 * 1024 * 1024 * 1024; // 4GB for video conversion
  } else if (req.path === '/process-zip') {
    fileSizeLimit = 500 * 1024 * 1024; // 500MB for zip processing
  } else if (req.path === '/normalize-video') {
    fileSizeLimit = 60 * 1024 * 1024; // 60MB for video normalization (<50MB videos)
  }
  
  // Set longer timeout for video and zip uploads
  if (req.path === '/convert-video' || req.path === '/process-zip') {
    req.setTimeout(6 * 60 * 60 * 1000); // 6 hours for processing
    res.setTimeout(6 * 60 * 60 * 1000); // 6 hours for processing
  } else if (req.path === '/normalize-video') {
    req.setTimeout(10 * 60 * 1000); // 10 minutes for normalization
    res.setTimeout(10 * 60 * 1000);
  }
  
  fileUpload({
    limits: { fileSize: fileSizeLimit },
    abortOnLimit: false, // Don't abort on limit, let the route handle it
    useTempFiles: true,
    tempFileDir: '/tmp/',
    debug: false, // Disable debug to reduce log noise
    // Optimize for faster uploads
    preserveExtension: true,
    safeFileNames: false,
    // Add response timeout for large files
    responseTimeout: (req.path === '/convert-video' || req.path === '/process-zip') ? 6 * 60 * 60 * 1000 : 
                     (req.path === '/normalize-video') ? 10 * 60 * 1000 : 30000
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
app.use('/', zipRouter);         // ZIP processing routes

// Health check endpoint (no authorization required)
app.get('/health', (req, res) => {
  const startTime = Date.now();
  
  // Optimize health check for faster response
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  res.status(200).json({ 
    status: 'ok', 
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
  
  const responseTime = Date.now() - startTime;
  if (responseTime > 1000) {
    console.log(`[HEALTH-CHECK] Slow response: ${responseTime}ms`);
  }
});

// Redirect root to file browser
app.get('/', (req, res) => {
  res.redirect('/files');
});

// Start the server for both IPv4 and IPv6
app.listen(port, '::', async () => {
  console.log(`Server listening on port ${port}`);
  console.log(`File browser available at http://server-ip:${port}/files`);
  console.log(`IPv6 support enabled - listening on all interfaces`);
  
  // Initialize services on startup
  await initializeLeither();
  await initializeHardwareEncoders();
});