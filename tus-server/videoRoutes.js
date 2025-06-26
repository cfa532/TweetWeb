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
    
    // Find and remove old hls-convert directories (older than 1 hour)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    files.forEach(file => {
      if (file.startsWith('hls-convert-')) {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory() && stats.mtime.getTime() < oneHourAgo) {
          try {
            fs.rmSync(filePath, { recursive: true, force: true });
            console.log(`[CLEANUP] Removed old temporary directory: ${filePath}`);
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
        resolve(available);
      })
      .catch(() => {
        console.log('[HARDWARE] No hardware encoders detected, using software encoding');
        resolve({ nvidia: false, intel: false, apple: false, amd: false });
      });
  });
}

// Helper function to test if a hardware encoder actually works
function testHardwareEncoder(encoder) {
  return new Promise((resolve) => {
    // Create a simple test command to verify the encoder works
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

// Helper function to get optimal encoder settings with testing
async function getOptimalEncoder(availableEncoders) {
  // Priority order: NVIDIA > Intel > Apple > AMD > Software
  if (availableEncoders.nvidia) {
    const nvidiaWorks = await testHardwareEncoder('h264_nvenc');
    if (nvidiaWorks) {
      return {
        encoder: 'h264_nvenc',
        preset: 'fast',
        profile: 'main',
        level: '4.1',
        hardware: true
      };
    } else {
      console.log('[HARDWARE] NVIDIA encoder failed test, trying Intel...');
    }
  }
  
  if (availableEncoders.intel) {
    const intelWorks = await testHardwareEncoder('h264_qsv');
    if (intelWorks) {
      return {
        encoder: 'h264_qsv',
        preset: 'fast',
        profile: 'main',
        level: '4.1',
        hardware: true
      };
    } else {
      console.log('[HARDWARE] Intel encoder failed test, trying Apple...');
    }
  }
  
  if (availableEncoders.apple) {
    const appleWorks = await testHardwareEncoder('h264_videotoolbox');
    if (appleWorks) {
      return {
        encoder: 'h264_videotoolbox',
        preset: 'fast',
        profile: 'main',
        level: '4.1',
        hardware: true
      };
    } else {
      console.log('[HARDWARE] Apple encoder failed test, trying AMD...');
    }
  }
  
  if (availableEncoders.amd) {
    const amdWorks = await testHardwareEncoder('h264_amf');
    if (amdWorks) {
      return {
        encoder: 'h264_amf',
        preset: 'fast',
        profile: 'main',
        level: '4.1',
        hardware: true
      };
    } else {
      console.log('[HARDWARE] AMD encoder failed test, falling back to software...');
    }
  }
  
  console.log('[HARDWARE] All hardware encoders failed or unavailable, using software encoding');
  return {
    encoder: 'libx264',
    preset: 'fast',
    profile: 'main',
    level: '4.1',
    hardware: false
  };
}

// Helper function to create HLS conversion commands with hardware acceleration
function createHLSConversionCommands(inputPath, tempDir, videoInfo, isPortrait, encoderConfig) {
  const commands = [];
  
  // Create directories for different qualities
  fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });
  
  // Calculate dimensions for scaling while preserving aspect ratio
  const width720 = 720;
  const height720 = Math.round((720 * videoInfo.height) / videoInfo.width);
  const width480 = 480;
  const height480 = Math.round((480 * videoInfo.height) / videoInfo.width);
  
  // Ensure dimensions are even
  const dim720 = ensureEvenDimensions(width720, height720);
  const dim480 = ensureEvenDimensions(width480, height480);
  
  // Set bitrates based on orientation
  const bitrate720 = isPortrait ? 4000 : 5000;
  const bitrate480 = isPortrait ? 2000 : 2500;
  
  // Hardware-specific encoding parameters
  const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder) : '';
  
  // Create ffmpeg commands with hardware acceleration
  const cmd720p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder} -preset ${encoderConfig.preset} -profile:v ${encoderConfig.profile} -level ${encoderConfig.level} -c:a aac -vf "scale=${dim720.width}:${dim720.height}:flags=lanczos" -aspect ${videoInfo.width}:${videoInfo.height} -b:v ${bitrate720}k ${hwParams} -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
  
  const cmd480p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder} -preset ${encoderConfig.preset} -profile:v ${encoderConfig.profile} -level ${encoderConfig.level} -c:a aac -vf "scale=${dim480.width}:${dim480.height}:flags=lanczos" -aspect ${videoInfo.width}:${videoInfo.height} -b:v ${bitrate480}k ${hwParams} -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '480p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '480p/playlist.m3u8'))}`;
  
  commands.push(cmd720p, cmd480p);
  
  // Create master playlist
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
function getHardwareEncodingParams(encoder) {
  switch (encoder) {
    case 'h264_nvenc':
      return '-rc vbr -cq 23 -b:v 0 -maxrate 5M -bufsize 10M';
    case 'h264_qsv':
      return '-global_quality 23 -look_ahead 1';
    case 'h264_videotoolbox':
      return '-allow_sw 1 -b:v 0';
    case 'h264_amf':
      return '-rc cqp -qp_i 23 -qp_p 23';
    default:
      return '';
  }
}

// Video conversion endpoint (no authentication required)
router.post('/convert-video', async (req, res) => {
  const routeStartTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] --- /convert-video route processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;

  try {
    // Cleanup old temporary files before starting new conversion
    console.log('[CLEANUP] Cleaning up old temporary files...');
    cleanupOldTempFiles();

    // --- 1. VALIDATE UPLOAD ---
    console.log('[STEP 1] Validating uploaded video file...');
    if (!req.files || !req.files.videoFile) {
      console.error('[ERROR] No video file found in request. Expected a file with field name "videoFile".');
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded. Please use the "videoFile" field name.'
      });
    }

    uploadedFile = req.files.videoFile;
    console.log(`[INFO] Received video: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);
    console.log(`[DEBUG] File temporarily stored at: ${uploadedFile.tempFilePath}`);

    // Check file size limit (1GB = 1024 * 1024 * 1024 bytes)
    const maxFileSize = 1024 * 1024 * 1024; // 1GB
    if (uploadedFile.size > maxFileSize) {
      console.error(`[ERROR] File size ${uploadedFile.size} exceeds limit of ${maxFileSize}`);
      return res.status(400).json({
        success: false,
        message: `File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 1GB.`
      });
    }

    // Parse the noResample parameter from form data
    const noResample = req.body.noResample === 'true' || req.body.noResample === true;
    console.log(`[INFO] noResample parameter: ${noResample}`);

    const allowedTypes = [
      'video/mp4', 
      'video/avi', 
      'video/mov', 
      'video/quicktime',  // MOV files
      'video/mkv', 
      'video/wmv', 
      'video/flv', 
      'video/webm',
      'video/x-msvideo',  // AVI alternative MIME type
      'video/x-matroska', // MKV alternative MIME type
      'video/x-ms-wmv',   // WMV alternative MIME type
      'video/x-flv'       // FLV alternative MIME type
    ];
    if (!allowedTypes.includes(uploadedFile.mimetype)) {
      console.error(`[ERROR] Unsupported video type: '${uploadedFile.mimetype}'.`);
      return res.status(400).json({
        success: false,
        message: `Invalid video type. Allowed types are: ${allowedTypes.join(', ')}`
      });
    }
    console.log('[SUCCESS] Video validation complete.');

    // --- 2. CREATE TEMPORARY DIRECTORY FOR HLS OUTPUT ---
    console.log('\n[STEP 2] Creating temporary directory for HLS output...');
    tempDir = path.join(os.tmpdir(), `hls-convert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[INFO] Created temporary directory: ${tempDir}`);

    // --- 3. GET VIDEO DIMENSIONS (only if resampling is needed) ---
    let videoInfo = null;
    let isPortrait = false;
    
    if (!noResample) {
      console.log('\n[STEP 3] Getting video dimensions for resampling...');
      const getVideoInfo = () => {
        return new Promise((resolve, reject) => {
          const ffprobeCommand = `ffprobe -v quiet -print_format json -show_format -show_streams ${escapeShellArg(uploadedFile.tempFilePath)}`;
          
          execAsync(ffprobeCommand, { encoding: 'utf-8', timeout: 30000 }) // 30 second timeout for ffprobe
            .then(result => {
              console.log('[DEBUG] ffprobe stdout:', result.stdout);
              console.log('[DEBUG] ffprobe stderr:', result.stderr);
              
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
                
                // Validate dimensions
                if (!videoStream.width || !videoStream.height || videoStream.width <= 0 || videoStream.height <= 0) {
                  reject(new Error('Invalid video dimensions'));
                  return;
                }
                
                resolve({
                  width: videoStream.width,
                  height: videoStream.height,
                  duration: metadata.format.duration ? parseFloat(metadata.format.duration) : null
                });
              } catch (parseError) {
                console.error('[ERROR] Failed to parse ffprobe JSON:', parseError);
                console.error('[ERROR] Raw stdout:', result.stdout);
                reject(new Error(`Failed to parse video metadata: ${parseError.message}`));
              }
            })
            .catch(reject);
        });
      };

      videoInfo = await getVideoInfo();
      console.log(`[INFO] Video dimensions: ${videoInfo.width}x${videoInfo.height}, duration: ${videoInfo.duration}s`);
      
      isPortrait = videoInfo.height > videoInfo.width;
      console.log(`[INFO] Video orientation: ${isPortrait ? 'Portrait' : 'Landscape'}`);
    } else {
      console.log('\n[STEP 3] Skipping video dimension analysis (noResample=true)');
    }

    // --- 4. CONVERT TO HLS ---
    console.log('\n[STEP 4] Converting video to HLS format...');
    console.time('hls-conversion');
    
    const convertToHLS = async () => {
      return new Promise(async (resolve, reject) => {
        let ffmpegCommand;
        
        if (noResample) {
          // Direct conversion to HLS without resampling
          console.log('[INFO] Converting video to HLS without resampling (preserving original quality)');
          ffmpegCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v copy -c:a copy -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
          
          execAsync(ffmpegCommand, { timeout: 24 * 60 * 60 * 1000 }) // 24 hour timeout for large files
            .then(() => {
              console.log('[SUCCESS] HLS conversion completed');
              resolve();
            })
            .catch((err) => {
              console.error('[ERROR] HLS conversion failed:', err);
              reject(err);
            });
        } else {
          // Multi-quality conversion
          console.log('[INFO] Converting video to HLS with multiple qualities');
          const availableEncoders = await detectHardwareEncoders();
          const encoderConfig = await getOptimalEncoder(availableEncoders);
          console.log(`[HARDWARE] Using encoder: ${encoderConfig.encoder} (hardware: ${encoderConfig.hardware})`);
          
          // Try hardware encoding first, fallback to software if it fails
          try {
            const commands = createHLSConversionCommands(uploadedFile.tempFilePath, tempDir, videoInfo, isPortrait, encoderConfig);
            
            // Execute both conversions in parallel with 24 hour timeout
            await Promise.all([
              execAsync(commands[0], { timeout: 24 * 60 * 60 * 1000 }), // 24 hour timeout
              execAsync(commands[1], { timeout: 24 * 60 * 60 * 1000 })
            ]);
            console.log('[SUCCESS] Multi-quality HLS conversion completed');
          } catch (hardwareError) {
            console.error('[HARDWARE] Hardware encoding failed:', hardwareError.message);
            
            if (encoderConfig.hardware) {
              console.log('[HARDWARE] Falling back to software encoding...');
              // Fallback to software encoding
              const softwareConfig = {
                encoder: 'libx264',
                preset: 'fast',
                profile: 'main',
                level: '4.1',
                hardware: false
              };
              
              const fallbackCommands = createHLSConversionCommands(uploadedFile.tempFilePath, tempDir, videoInfo, isPortrait, softwareConfig);
              
              await Promise.all([
                execAsync(fallbackCommands[0], { timeout: 24 * 60 * 60 * 1000 }),
                execAsync(fallbackCommands[1], { timeout: 24 * 60 * 60 * 1000 })
              ]);
              console.log('[SUCCESS] Multi-quality HLS conversion completed with software fallback');
            } else {
              // If it was already software encoding, re-throw the error
              throw hardwareError;
            }
          }
          
          resolve();
        }
      });
    };

    await convertToHLS();
    console.timeEnd('hls-conversion');

    // --- 5. PROCESS WITH LEITHER ---
    console.log('\n[STEP 5] Processing with Leither service...');
    console.time('leither-total-time');
    let leitherPort;
    
    try {
      console.time('leither-port-detection');
      leitherPort = await getLeitherPort();
      console.timeEnd('leither-port-detection');
      console.log(`[INFO] Detected Leither service on port: ${leitherPort}`);

      const client = hprose.Client.create(`ws://127.0.0.1:${leitherPort}/ws/`, ayApi);
      
      console.time('leither-get-ppt');
      console.log('[INFO] Getting PPT from Leither service...');
      console.log(`[DEBUG] Calling Getvar("", "ver")...`);
      const leitherVersion = await client.Getvar("", "ver");
      console.log(`[DEBUG] Leither version: ${leitherVersion}`);
      const ppt = await client.GetVarByContext("", "context_ppt", []);
      console.timeEnd('leither-get-ppt');
      if (!ppt) throw new Error("Failed to get PPT from Leither service.");
      console.log('[SUCCESS] PPT received.');

      console.time('leither-login');
      console.log('[INFO] Logging in to Leither service...');
      const api = await client.Login(ppt);
      console.timeEnd('leither-login');
      if (!api || !api.sid) throw new Error("Login to Leither service failed.");
      console.log('[SUCCESS] Login successful. SID:', api.sid);

      console.time('leither-ipfs-add');
      console.log(`[INFO] Adding HLS content to IPFS from path: '${tempDir}'`);

      const defaultTimeout = client.timeout;
      client.timeout = 0;
      const cid = await client.IpfsAdd(api.sid, tempDir);
      client.timeout = defaultTimeout;
      console.timeEnd('leither-ipfs-add');
      console.log('[SUCCESS] IPFS CID received:', cid);

      console.timeEnd('leither-total-time');
      
      res.json({
        success: true,
        message: 'Video converted to HLS and added to IPFS successfully',
        cid: cid,
        tempDir: tempDir // Return temp directory for potential reuse
      });

    } catch (leitherError) {
      console.error('[FATAL] Leither service error:', leitherError);
      console.timeEnd('leither-total-time');
      
      res.json({
        success: false,
        message: 'Video converted to HLS successfully, but Leither service failed',
        error: leitherError.message,
        tempDir: tempDir // Return temp directory even on failure for potential reuse
      });
    }

  } catch (error) {
    console.error('[FATAL] An unexpected error occurred in /convert-video route:', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to process video due to a server error.',
      error: error.message,
      tempDir: tempDir // Return temp directory if available
    });
  } finally {
    // Only cleanup the uploaded file, keep the converted HLS files for potential reuse
    if (uploadedFile && uploadedFile.tempFilePath && fs.existsSync(uploadedFile.tempFilePath)) {
      try {
        fs.unlinkSync(uploadedFile.tempFilePath);
        console.log(`[CLEANUP] Removed temporary uploaded file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        console.error('[ERROR] Failed to cleanup uploaded file:', cleanupError);
      }
    }
    
    console.log(`[INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
    console.log(`[INFO] HLS files preserved in: ${tempDir}`);
    console.log(`[${new Date().toISOString()}] --- /convert-video route processing finished ---\n`);
  }
});

module.exports = router; 