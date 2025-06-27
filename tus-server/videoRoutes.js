const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const hprose = require('hprose');
const { getLeitherPort } = require('./leitherDetector');

// Promisify exec for async/await usage
const execAsync = promisify(exec);

// Concurrency management
let activeUploads = 0;
const maxConcurrentUploads = 3;
const uploadQueue = [];
let isProcessingQueue = false;

// Hardware encoder cache to avoid repeated detection
let hardwareEncoderCache = null;
let hardwareEncoderCacheTime = 0;
const HARDWARE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Leither connection pool
const leitherConnections = new Map();
const maxLeitherConnections = 2;

// Helper function to manage upload concurrency
function processUploadQueue() {
  if (isProcessingQueue || uploadQueue.length === 0 || activeUploads >= maxConcurrentUploads) {
    return;
  }
  
  isProcessingQueue = true;
  
  while (uploadQueue.length > 0 && activeUploads < maxConcurrentUploads) {
    const { req, res, resolve, reject } = uploadQueue.shift();
    activeUploads++;
    
    console.log(`[CONCURRENCY] Starting upload ${activeUploads}/${maxConcurrentUploads}. Queue length: ${uploadQueue.length}`);
    
    processVideoUpload(req, res)
      .then(result => {
        activeUploads--;
        console.log(`[CONCURRENCY] Upload completed. Active: ${activeUploads}/${maxConcurrentUploads}`);
        resolve(result);
        processUploadQueue();
      })
      .catch(error => {
        activeUploads--;
        console.log(`[CONCURRENCY] Upload failed. Active: ${activeUploads}/${maxConcurrentUploads}`);
        reject(error);
        processUploadQueue();
      });
  }
  
  isProcessingQueue = false;
}

// Helper function to get or create Leither connection
async function getLeitherConnection() {
  const port = await getLeitherPort();
  const connectionKey = `port-${port}`;
  
  if (leitherConnections.has(connectionKey)) {
    const connection = leitherConnections.get(connectionKey);
    if (connection.isAvailable) {
      connection.isAvailable = false;
      return connection.client;
    }
  }
  
  if (leitherConnections.size < maxLeitherConnections) {
    const client = await createLeitherClient(port);
    leitherConnections.set(connectionKey, {
      client,
      isAvailable: false,
      port
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

// Helper function to release Leither connection
function releaseLeitherConnection(client) {
  for (const [key, conn] of leitherConnections) {
    if (conn.client === client) {
      conn.isAvailable = true;
      break;
    }
  }
}

// Enhanced Leither client creation with better error handling
function createLeitherClient(port, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const maxRetries = 3;
    const retryDelay = 2000;
    
    try {
      console.log(`[LEITHER] Creating client connection to port ${port} (attempt ${retryCount + 1}/${maxRetries + 1})`);
      
      const client = hprose.Client.create(`ws://127.0.0.1:${port}/ws/`, ayApi);
      client.timeout = 30000;
      
      if (client.connection) {
        client.connection.on('open', () => {
          console.log(`[LEITHER] WebSocket connection established to port ${port}`);
          resolve(client);
        });
        
        client.connection.on('close', (code, reason) => {
          console.log(`[LEITHER] WebSocket connection closed: code=${code}, reason=${reason}`);
          if (retryCount < maxRetries) {
            console.log(`[LEITHER] Retrying connection in ${retryDelay}ms...`);
            setTimeout(() => {
              createLeitherClient(port, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, retryDelay);
          } else {
            reject(new Error(`Failed to establish WebSocket connection after ${maxRetries + 1} attempts. Last error: code=${code}, reason=${reason}`));
          }
        });
        
        client.connection.on('error', (error) => {
          console.error(`[LEITHER] WebSocket connection error:`, error);
          if (retryCount < maxRetries) {
            console.log(`[LEITHER] Retrying connection in ${retryDelay}ms...`);
            setTimeout(() => {
              createLeitherClient(port, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, retryDelay);
          } else {
            reject(new Error(`WebSocket connection failed after ${maxRetries + 1} attempts: ${error.message}`));
          }
        });
      } else {
        resolve(client);
      }
      
    } catch (error) {
      console.error(`[LEITHER] Error creating client:`, error);
      if (retryCount < maxRetries) {
        console.log(`[LEITHER] Retrying client creation in ${retryDelay}ms...`);
        setTimeout(() => {
          createLeitherClient(port, retryCount + 1)
            .then(resolve)
            .catch(reject);
        }, retryDelay);
      } else {
        reject(error);
      }
    }
  });
}

// Leither API array for IPFS integration
const ayApi = ["GetVarByContext", "Act", "Login", "Getvar", "Getnodeip", "SwarmLocal", "DhtGetAllKeys","MFOpenByPath",
  "DhtGet", "DhtGets", "SignPPT", "RequestService", "SwarmAddrs", "MFOpenTempFile", "MFTemp2MacFile", "MFSetData",
  "MFGetData", "MMCreate", "MMOpen", "Hset", "Hget", "Hmset", "Hmget", "Zadd", "Zrangebyscore", "Zrange", "MFOpenMacFile",
  "MFReaddir", "MFGetMimeType", "MFSetObject", "MFGetObject", "Zcount", "Zrevrange", "Hlen", "Hscan", "Hrevscan",
  "MMRelease", "MMBackup", "MFStat", "Zrem", "Zremrangebyscore", "MiMeiPublish", "PullMsg", "MFTemp2Ipfs", "MFSetCid",
  "MMSum", "MiMeiSync", "IpfsAdd", "MMAddRef", "MMDelRef", "MMDelVers", "MMRelease", "MMGetRef", "MMGetRefs", "Hdel",
  "DhtFindPeer", "Logout", "MiMeiPublish", "MMSetRight"
];

// Helper function to safely escape file paths for shell commands
function escapeShellArg(arg) {
  return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

// Helper function to ensure dimensions are even (required for H.264)
function ensureEvenDimensions(width, height) {
  return {
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1
  };
}

// Helper function to cleanup old temporary files and directories
function cleanupOldTempFiles() {
  try {
    const tempDir = os.tmpdir();
    const files = fs.readdirSync(tempDir);
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    files.forEach(file => {
      if (file.startsWith('hls-convert-')) {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory() && stats.mtime.getTime() < oneHourAgo) {
          try {
            const isInUse = activeUploads > 0 && filePath.includes('hls-convert-');
            if (!isInUse) {
              fs.rmSync(filePath, { recursive: true, force: true });
              console.log(`[CLEANUP] Removed old temporary directory: ${filePath}`);
            } else {
              console.log(`[CLEANUP] Skipping directory in use: ${filePath}`);
            }
          } catch (cleanupError) {
            console.error(`[ERROR] Failed to cleanup old directory ${filePath}:`, cleanupError);
          }
        }
      }
    });
  } catch (error) {
    console.error('[ERROR] Failed to cleanup old temporary files:', error);
  }
}

// Helper function to detect available hardware encoders
function detectHardwareEncoders() {
  return new Promise((resolve) => {
    if (hardwareEncoderCache && (Date.now() - hardwareEncoderCacheTime) < HARDWARE_CACHE_DURATION) {
      console.log('[HARDWARE] Using cached encoder detection');
      resolve(hardwareEncoderCache);
      return;
    }
    
    execAsync('ffmpeg -hide_banner -encoders | grep -E "(h264_nvenc|h264_qsv|h264_videotoolbox|h264_amf)"', { timeout: 10000 })
      .then(result => {
        const encoders = result.stdout.toLowerCase();
        const available = {
          nvidia: encoders.includes('h264_nvenc'),
          intel: encoders.includes('h264_qsv'),
          apple: encoders.includes('h264_videotoolbox'),
          amd: encoders.includes('h264_amf')
        };
        console.log('[HARDWARE] Available encoders:', available);
        
        hardwareEncoderCache = available;
        hardwareEncoderCacheTime = Date.now();
        resolve(available);
      })
      .catch(() => {
        console.log('[HARDWARE] No hardware encoders detected, using software encoding');
        const available = { nvidia: false, intel: false, apple: false, amd: false };
        hardwareEncoderCache = available;
        hardwareEncoderCacheTime = Date.now();
        resolve(available);
      });
  });
}

// Helper function to test if a hardware encoder actually works
function testHardwareEncoder(encoder) {
  return new Promise((resolve) => {
    const testCommand = `ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=1 -c:v ${encoder} -f null - 2>&1`;
    
    execAsync(testCommand, { timeout: 15000 })
      .then(() => {
        console.log(`[HARDWARE] Encoder ${encoder} test passed`);
        resolve(true);
      })
      .catch((error) => {
        console.log(`[HARDWARE] Encoder ${encoder} test failed:`, error.message);
        resolve(false);
      });
  });
}

// Helper function to get optimal encoder settings
async function getOptimalEncoder(availableEncoders, videoInfo = null) {
  const is10Bit = videoInfo && videoInfo.bitDepth && videoInfo.bitDepth > 8;
  
  if (availableEncoders.nvidia) {
    const nvidiaWorks = await testHardwareEncoder('h264_nvenc');
    if (nvidiaWorks) {
      return {
        encoder: 'h264_nvenc',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit
      };
    }
  }
  
  if (availableEncoders.intel) {
    const intelWorks = await testHardwareEncoder('h264_qsv');
    if (intelWorks) {
      return {
        encoder: 'h264_qsv',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit
      };
    }
  }
  
  if (availableEncoders.apple) {
    const appleWorks = await testHardwareEncoder('h264_videotoolbox');
    if (appleWorks) {
      return {
        encoder: 'h264_videotoolbox',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit
      };
    }
  }
  
  if (availableEncoders.amd) {
    const amdWorks = await testHardwareEncoder('h264_amf');
    if (amdWorks) {
      return {
        encoder: 'h264_amf',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit
      };
    }
  }
  
  console.log('[HARDWARE] All hardware encoders failed or unavailable, using software encoding');
  return {
    encoder: 'libx264',
    preset: 'fast',
    profile: is10Bit ? 'high10' : 'main',
    level: '4.1',
    hardware: false,
    is10Bit: is10Bit
  };
}

// Helper function to create HLS conversion commands
function createHLSConversionCommands(inputPath, tempDir, videoInfo, encoderConfig) {
  const commands = [];
  
  fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });
  
  const displayWidth = videoInfo.displayWidth || videoInfo.width;
  const displayHeight = videoInfo.displayHeight || videoInfo.height;

  let targetWidth720, targetHeight720, targetWidth480, targetHeight480;
  if (displayHeight > displayWidth) {
    targetHeight720 = 720;
    targetWidth720 = Math.round((720 * displayWidth) / displayHeight);
    targetHeight480 = 480;
    targetWidth480 = Math.round((480 * displayWidth) / displayHeight);
  } else {
    targetWidth720 = 720;
    targetHeight720 = Math.round((720 * displayHeight) / displayWidth);
    targetWidth480 = 480;
    targetHeight480 = Math.round((480 * displayHeight) / displayWidth);
  }

  const dim720 = ensureEvenDimensions(targetWidth720, targetHeight720);
  const dim480 = ensureEvenDimensions(targetWidth480, targetHeight480);

  const isDisplayPortrait = displayHeight > displayWidth;
  const bitrate720 = isDisplayPortrait ? 4000 : 5000;
  const bitrate480 = isDisplayPortrait ? 2000 : 2500;

  const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder, encoderConfig.is10Bit) : '';

  const cmd720p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder} -preset ${encoderConfig.preset} -profile:v ${encoderConfig.profile} -level ${encoderConfig.level} -c:a aac -vf "scale=${dim720.width}:${dim720.height}:flags=lanczos" -b:v ${bitrate720}k ${hwParams} -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;

  const cmd480p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder} -preset ${encoderConfig.preset} -profile:v ${encoderConfig.profile} -level ${encoderConfig.level} -c:a aac -vf "scale=${dim480.width}:${dim480.height}:flags=lanczos" -b:v ${bitrate480}k ${hwParams} -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '480p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '480p/playlist.m3u8'))}`;

  commands.push(cmd720p, cmd480p);
  
  const bandwidth720 = bitrate720 * 1000;
  const bandwidth480 = bitrate480 * 1000;
  
  const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth720},RESOLUTION=${dim720.width}x${dim720.height}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth480},RESOLUTION=${dim480.width}x${dim480.height}
480p/playlist.m3u8`;
  
  fs.writeFileSync(path.join(tempDir, 'master.m3u8'), masterPlaylist);
  
  return commands;
}

// Helper function to get hardware-specific encoding parameters
function getHardwareEncodingParams(encoder, is10Bit = false) {
  switch (encoder) {
    case 'h264_nvenc':
      return is10Bit ? '-rc vbr -cq 23 -b:v 0 -maxrate 5M -bufsize 10M -pix_fmt yuv420p10le' : '-rc vbr -cq 23 -b:v 0 -maxrate 5M -bufsize 10M';
    case 'h264_qsv':
      return is10Bit ? '-global_quality 23 -look_ahead 1 -pix_fmt yuv420p10le' : '-global_quality 23 -look_ahead 1';
    case 'h264_videotoolbox':
      return is10Bit ? '-allow_sw 1 -b:v 0 -pix_fmt yuv420p10le' : '-allow_sw 1 -b:v 0';
    case 'h264_amf':
      return is10Bit ? '-rc cqp -qp_i 23 -qp_p 23 -pix_fmt yuv420p10le' : '-rc cqp -qp_i 23 -qp_p 23';
    default:
      return is10Bit ? '-pix_fmt yuv420p10le' : '';
  }
}

// Main video processing function
async function processVideoUpload(req, res) {
  const routeStartTime = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  console.log(`\n[${new Date().toISOString()}] [${requestId}] --- /convert-video route processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;
  let leitherClient = null;

  try {
    if (activeUploads <= 1) {
      console.log(`[${requestId}] [CLEANUP] Cleaning up old temporary files...`);
      cleanupOldTempFiles();
    }

    // Validate upload
    if (!req.files || !req.files.videoFile) {
      console.error(`[${requestId}] [ERROR] No video file found in request. Expected a file with field name "videoFile".`);
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded. Please use the "videoFile" field name.'
      });
    }

    uploadedFile = req.files.videoFile;
    console.log(`[${requestId}] [INFO] Received video: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);

    const maxFileSize = 1024 * 1024 * 1024; // 1GB
    if (uploadedFile.size > maxFileSize) {
      console.error(`[${requestId}] [ERROR] File size ${uploadedFile.size} exceeds limit of ${maxFileSize}`);
      return res.status(400).json({
        success: false,
        message: `File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 1GB.`
      });
    }

    const noResample = req.body.noResample === 'true' || req.body.noResample === true;
    console.log(`[${requestId}] [INFO] noResample parameter: ${noResample}`);

    const allowedTypes = [
      'video/mp4', 'video/avi', 'video/mov', 'video/quicktime', 'video/mkv', 
      'video/wmv', 'video/flv', 'video/webm', 'video/x-msvideo', 
      'video/x-matroska', 'video/x-ms-wmv', 'video/x-flv'
    ];
    if (!allowedTypes.includes(uploadedFile.mimetype)) {
      console.error(`[${requestId}] [ERROR] Unsupported video type: '${uploadedFile.mimetype}'.`);
      return res.status(400).json({
        success: false,
        message: `Invalid video type. Allowed types are: ${allowedTypes.join(', ')}`
      });
    }

    // Create temporary directory
    tempDir = path.join(os.tmpdir(), `hls-convert-${Date.now()}-${requestId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[${requestId}] [INFO] Created temporary directory: ${tempDir}`);

    // Get video dimensions if resampling is needed
    let videoInfo = null;
    
    if (!noResample) {
      console.log(`\n[${requestId}] [STEP 3] Getting video dimensions for resampling...`);
      const getVideoInfo = () => {
        return new Promise((resolve, reject) => {
          const ffprobeCommand = `ffprobe -v quiet -print_format json -show_format -show_streams ${escapeShellArg(uploadedFile.tempFilePath)}`;
          
          execAsync(ffprobeCommand, { encoding: 'utf-8', timeout: 30000 })
            .then(result => {
              if (!result.stdout) {
                reject(new Error('No output from ffprobe'));
                return;
              }
              
              try {
                const metadata = JSON.parse(result.stdout);
                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                if (!videoStream) {
                  reject(new Error('No video stream found'));
                  return;
                }
                
                if (!videoStream.width || !videoStream.height || videoStream.width <= 0 || videoStream.height <= 0) {
                  reject(new Error('Invalid video dimensions'));
                  return;
                }
                
                let rotation = 0;
                if (videoStream.side_data_list) {
                  for (const sideData of videoStream.side_data_list) {
                    if (sideData.side_data_type === 'Display Matrix') {
                      const matrix = sideData.rotation;
                      if (matrix === -90) rotation = -90;
                      else if (matrix === 90) rotation = 90;
                      else if (matrix === 180) rotation = 180;
                      break;
                    }
                  }
                }
                
                let displayWidth = videoStream.width;
                let displayHeight = videoStream.height;
                
                if (rotation === 90 || rotation === -90) {
                  displayWidth = videoStream.height;
                  displayHeight = videoStream.width;
                }
                
                let bitDepth = 8;
                if (videoStream.pix_fmt) {
                  if (videoStream.pix_fmt.includes('10le') || videoStream.pix_fmt.includes('10be')) {
                    bitDepth = 10;
                  } else if (videoStream.pix_fmt.includes('12le') || videoStream.pix_fmt.includes('12be')) {
                    bitDepth = 12;
                  } else if (videoStream.pix_fmt.includes('16le') || videoStream.pix_fmt.includes('16be')) {
                    bitDepth = 16;
                  }
                }
                
                if (videoStream.profile && videoStream.profile.includes('Main 10')) {
                  bitDepth = 10;
                }
                
                console.log(`[${requestId}] [INFO] Video dimensions: ${videoStream.width}x${videoStream.height}`);
                console.log(`[${requestId}] [INFO] Display dimensions (after rotation): ${displayWidth}x${displayHeight}`);
                console.log(`[${requestId}] [INFO] Rotation: ${rotation} degrees`);
                console.log(`[${requestId}] [INFO] Detected video bit depth: ${bitDepth}-bit`);
                
                resolve({
                  width: videoStream.width,
                  height: videoStream.height,
                  displayWidth: displayWidth,
                  displayHeight: displayHeight,
                  rotation: rotation,
                  duration: metadata.format.duration ? parseFloat(metadata.format.duration) : null,
                  bitDepth: bitDepth,
                  pixelFormat: videoStream.pix_fmt,
                  profile: videoStream.profile,
                  codec: videoStream.codec_name
                });
              } catch (parseError) {
                console.error(`[${requestId}] [ERROR] Failed to parse ffprobe JSON:`, parseError);
                reject(new Error(`Failed to parse video metadata: ${parseError.message}`));
              }
            })
            .catch(reject);
        });
      };

      videoInfo = await getVideoInfo();
      console.log(`[${requestId}] [INFO] Video dimensions: ${videoInfo.width}x${videoInfo.height}, duration: ${videoInfo.duration}s`);
      
      const displayWidth = videoInfo.displayWidth || videoInfo.width;
      const displayHeight = videoInfo.displayHeight || videoInfo.height;
      console.log(`[${requestId}] [INFO] Display orientation: ${displayHeight > displayWidth ? 'Portrait' : 'Landscape'} (${displayWidth}x${displayHeight})`);
      if (videoInfo.rotation !== 0) {
        console.log(`[${requestId}] [INFO] Video has rotation: ${videoInfo.rotation}°`);
      }
    } else {
      console.log(`\n[${requestId}] [STEP 3] Skipping video dimension analysis (noResample=true)`);
    }

    // Convert to HLS
    console.log(`\n[${requestId}] [STEP 4] Converting video to HLS format...`);
    console.time(`[${requestId}] hls-conversion`);
    
    if (noResample) {
      const ffmpegCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v copy -c:a copy -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      
      await execAsync(ffmpegCommand, { timeout: 4 * 60 * 60 * 1000 });
      console.log(`[${requestId}] [SUCCESS] HLS conversion completed`);
    } else {
      const availableEncoders = await detectHardwareEncoders();
      const encoderConfig = await getOptimalEncoder(availableEncoders, videoInfo);
      console.log(`[${requestId}] [HARDWARE] Using encoder: ${encoderConfig.encoder} (hardware: ${encoderConfig.hardware})`);
      
      try {
        const commands = createHLSConversionCommands(uploadedFile.tempFilePath, tempDir, videoInfo, encoderConfig);
        
        await Promise.all([
          execAsync(commands[0], { timeout: 4 * 60 * 60 * 1000 }),
          execAsync(commands[1], { timeout: 4 * 60 * 60 * 1000 })
        ]);
        console.log(`[${requestId}] [SUCCESS] Multi-quality HLS conversion completed`);
      } catch (hardwareError) {
        console.error(`[${requestId}] [HARDWARE] Hardware encoding failed:`, hardwareError.message);
        
        if (encoderConfig.hardware) {
          console.log(`[${requestId}] [HARDWARE] Falling back to software encoding...`);
          const softwareConfig = {
            encoder: 'libx264',
            preset: 'fast',
            profile: encoderConfig.is10Bit ? 'high10' : 'main',
            level: '4.1',
            hardware: false,
            is10Bit: encoderConfig.is10Bit
          };
          
          const fallbackCommands = createHLSConversionCommands(uploadedFile.tempFilePath, tempDir, videoInfo, softwareConfig);
          
          await Promise.all([
            execAsync(fallbackCommands[0], { timeout: 4 * 60 * 60 * 1000 }),
            execAsync(fallbackCommands[1], { timeout: 4 * 60 * 60 * 1000 })
          ]);
          console.log(`[${requestId}] [SUCCESS] Multi-quality HLS conversion completed with software fallback`);
        } else {
          throw hardwareError;
        }
      }
    }
    
    console.timeEnd(`[${requestId}] hls-conversion`);

    // Process with Leither
    console.log(`\n[${requestId}] [STEP 5] Processing with Leither service...`);
    console.time(`[${requestId}] leither-total-time`);
    let timingLabels = new Set();
    
    try {
      console.time(`[${requestId}] leither-port-detection`);
      timingLabels.add('leither-port-detection');
      const leitherPort = await getLeitherPort();
      console.timeEnd(`[${requestId}] leither-port-detection`);
      timingLabels.delete('leither-port-detection');
      console.log(`[${requestId}] [INFO] Detected Leither service on port: ${leitherPort}`);

      leitherClient = await getLeitherConnection();
      
      console.time(`[${requestId}] leither-get-ppt`);
      timingLabels.add('leither-get-ppt');
      console.log(`[${requestId}] [INFO] Getting PPT from Leither service...`);
      
      const executeLeitherOperation = async (operation, operationName, maxRetries = 3) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            console.log(`[${requestId}] [LEITHER] ${operationName} (attempt ${attempt}/${maxRetries})`);
            const result = await Promise.race([
              operation(),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`${operationName} timeout after 4 hours`)), 3600000*4)
              )
            ]);
            console.log(`[${requestId}] [LEITHER] ${operationName} completed successfully`);
            return result;
          } catch (error) {
            console.error(`[${requestId}] [LEITHER] ${operationName} attempt ${attempt} failed:`, error.message);
            if (attempt === maxRetries) {
              throw error;
            }
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`[${requestId}] [LEITHER] Retrying ${operationName} in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      };
      
      const leitherVersion = await executeLeitherOperation(
        () => leitherClient.Getvar("", "ver"),
        "Getvar version"
      );
      console.log(`[${requestId}] [DEBUG] Leither version: ${leitherVersion}`);
      
      const ppt = await executeLeitherOperation(
        () => leitherClient.GetVarByContext("", "context_ppt", []),
        "GetVarByContext PPT"
      );
      console.timeEnd(`[${requestId}] leither-get-ppt`);
      timingLabels.delete('leither-get-ppt');
      if (!ppt) throw new Error("Failed to get PPT from Leither service.");
      console.log(`[${requestId}] [SUCCESS] PPT received.`);

      console.time(`[${requestId}] leither-login`);
      timingLabels.add('leither-login');
      console.log(`[${requestId}] [INFO] Logging in to Leither service...`);
      const api = await executeLeitherOperation(
        () => leitherClient.Login(ppt),
        "Login"
      );
      console.timeEnd(`[${requestId}] leither-login`);
      timingLabels.delete('leither-login');
      if (!api || !api.sid) throw new Error("Login to Leither service failed.");
      console.log(`[${requestId}] [SUCCESS] Login successful. SID:`, api.sid);

      console.time(`[${requestId}] leither-ipfs-add`);
      timingLabels.add('leither-ipfs-add');
      console.log(`[${requestId}] [INFO] Adding HLS content to IPFS from path: '${tempDir}'`);

      const defaultTimeout = leitherClient.timeout;
      leitherClient.timeout = 0;
      const cid = await executeLeitherOperation(
        () => leitherClient.IpfsAdd(api.sid, tempDir),
        "IpfsAdd",
        2
      );
      leitherClient.timeout = defaultTimeout;
      console.timeEnd(`[${requestId}] leither-ipfs-add`);
      timingLabels.delete('leither-ipfs-add');
      console.log(`[${requestId}] [SUCCESS] IPFS CID received:`, cid);

      console.timeEnd(`[${requestId}] leither-total-time`);
      timingLabels.delete('leither-total-time');
      
      res.json({
        success: true,
        message: 'Video converted to HLS and added to IPFS successfully',
        cid: cid,
        tempDir: tempDir
      });

    } catch (leitherError) {
      console.error(`[${requestId}] [FATAL] Leither service error:`, leitherError);
      
      // Clean up any active timing labels
      const labelsToClean = ['leither-total-time', 'leither-get-ppt', 'leither-login', 'leither-ipfs-add', 'leither-port-detection'];
      labelsToClean.forEach(label => {
        if (timingLabels.has(label)) {
          console.timeEnd(`[${requestId}] ${label}`);
          timingLabels.delete(label);
        }
      });
      
      let errorMessage = 'Video converted to HLS successfully, but Leither service failed';
      if (leitherError.message.includes('1006')) {
        errorMessage = 'Video converted to HLS successfully, but Leither service connection was lost (Error 1006). Please check if Leither service is running.';
      } else if (leitherError.message.includes('timeout')) {
        errorMessage = 'Video converted to HLS successfully, but Leither service operation timed out. The service may be overloaded.';
      } else if (leitherError.message.includes('WebSocket')) {
        errorMessage = 'Video converted to HLS successfully, but Leither service WebSocket connection failed. Please check network connectivity.';
      }
      
      res.json({
        success: false,
        message: errorMessage,
        error: leitherError.message,
        tempDir: tempDir
      });
    }

  } catch (error) {
    console.error(`[${requestId}] [FATAL] An unexpected error occurred in /convert-video route:`, error);

    res.status(500).json({
      success: false,
      message: 'Failed to process video due to a server error.',
      error: error.message,
      tempDir: tempDir
    });
  } finally {
    if (leitherClient) {
      releaseLeitherConnection(leitherClient);
    }
    
    if (uploadedFile && uploadedFile.tempFilePath && fs.existsSync(uploadedFile.tempFilePath)) {
      try {
        fs.unlinkSync(uploadedFile.tempFilePath);
        console.log(`[${requestId}] [CLEANUP] Removed temporary uploaded file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        console.error(`[${requestId}] [ERROR] Failed to cleanup uploaded file:`, cleanupError);
      }
    }
    
    console.log(`[${requestId}] [INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
    console.log(`[${requestId}] [INFO] HLS files preserved in: ${tempDir}`);
    console.log(`[${new Date().toISOString()}] [${requestId}] --- /convert-video route processing finished ---\n`);
  }
}

// Video conversion endpoint
router.post('/convert-video', async (req, res) => {
  if (activeUploads >= maxConcurrentUploads) {
    console.log(`[CONCURRENCY] Upload queue full (${activeUploads}/${maxConcurrentUploads}). Queuing request...`);
    
    const queuePromise = new Promise((resolve, reject) => {
      uploadQueue.push({ req, res, resolve, reject });
    });
    
    processUploadQueue();
    
    try {
      await queuePromise;
    } catch (error) {
      console.error('[CONCURRENCY] Queued upload failed:', error);
    }
  } else {
    try {
      await processVideoUpload(req, res);
    } catch (error) {
      console.error('[CONCURRENCY] Immediate upload failed:', error);
    }
  }
});

module.exports = router; 