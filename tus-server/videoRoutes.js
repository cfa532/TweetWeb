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

// Video conversion endpoint (no authentication required)
router.post('/convert-video', async (req, res) => {
  const routeStartTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] --- /convert-video route processing started ---`);

  try {
    // --- 1. VALIDATE UPLOAD ---
    console.log('[STEP 1] Validating uploaded video file...');
    if (!req.files || !req.files.videoFile) {
      console.error('[ERROR] No video file found in request. Expected a file with field name "videoFile".');
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded. Please use the "videoFile" field name.'
      });
    }

    const uploadedFile = req.files.videoFile;
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
    const tempDir = path.join(os.tmpdir(), `hls-convert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[INFO] Created temporary directory: ${tempDir}`);

    // --- 3. GET VIDEO DIMENSIONS (only if resampling is needed) ---
    let videoInfo = null;
    let isPortrait = false;
    
    if (!noResample) {
      console.log('\n[STEP 3] Getting video dimensions for resampling...');
      const getVideoInfo = () => {
        return new Promise((resolve, reject) => {
          execAsync(`ffprobe -v quiet -print_format json -show_format -show_streams "${uploadedFile.tempFilePath}"`, { encoding: 'utf-8' })
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
    
    const convertToHLS = () => {
      return new Promise((resolve, reject) => {
        let ffmpegCommand;
        
        if (noResample) {
          // Direct conversion to HLS without resampling
          console.log('[INFO] Converting video to HLS without resampling (preserving original quality)');
          ffmpegCommand = `ffmpeg -i "${uploadedFile.tempFilePath}" -c:v copy -c:a copy -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename "${path.join(tempDir, 'segment%03d.ts')}" "${path.join(tempDir, 'playlist.m3u8')}"`;
        } else if (isPortrait) {
          // Portrait: create two qualities (720p and 480p) regardless of original width
          // Create directories for different qualities
          fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
          fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });
          
          // Calculate dimensions for scaling while preserving aspect ratio
          const width720 = 720;
          const height720 = Math.round((720 * videoInfo.height) / videoInfo.width);
          const width480 = 480;
          const height480 = Math.round((480 * videoInfo.height) / videoInfo.width);
          
          // Ensure dimensions are even (required for H.264)
          const evenWidth720 = width720 % 2 === 0 ? width720 : width720 - 1;
          const evenHeight720 = height720 % 2 === 0 ? height720 : height720 - 1;
          const evenWidth480 = width480 % 2 === 0 ? width480 : width480 - 1;
          const evenHeight480 = height480 % 2 === 0 ? height480 : height480 - 1;
          
          // Convert to 720p with higher bitrate, preserving aspect ratio
          const cmd720p = `ffmpeg -i "${uploadedFile.tempFilePath}" -c:v libx264 -c:a aac -vf "scale=${evenWidth720}:${evenHeight720}:flags=lanczos" -aspect ${videoInfo.width}:${videoInfo.height} -b:v 4000k -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename "${path.join(tempDir, '720p/segment%03d.ts')}" "${path.join(tempDir, '720p/playlist.m3u8')}"`;
          
          // Convert to 480p with higher bitrate, preserving aspect ratio
          const cmd480p = `ffmpeg -i "${uploadedFile.tempFilePath}" -c:v libx264 -c:a aac -vf "scale=${evenWidth480}:${evenHeight480}:flags=lanczos" -aspect ${videoInfo.width}:${videoInfo.height} -b:v 2000k -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename "${path.join(tempDir, '480p/segment%03d.ts')}" "${path.join(tempDir, '480p/playlist.m3u8')}"`;
          
          // Create master playlist with actual dimensions and updated bandwidth
          const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=${evenWidth720}x${evenHeight720}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=${evenWidth480}x${evenHeight480}
480p/playlist.m3u8`;
          
          fs.writeFileSync(path.join(tempDir, 'master.m3u8'), masterPlaylist);
          
          // Execute both conversions in parallel
          Promise.all([
            execAsync(cmd720p),
            execAsync(cmd480p)
          ]).then(() => resolve()).catch(reject);
          return;
        } else {
          // Landscape: two qualities (720 and 480 width)
          // Create directories for different qualities
          fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
          fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });
          
          // Calculate dimensions for scaling while preserving aspect ratio
          const width720 = 720;
          const height720 = Math.round((720 * videoInfo.height) / videoInfo.width);
          const width480 = 480;
          const height480 = Math.round((480 * videoInfo.height) / videoInfo.width);
          
          // Ensure dimensions are even (required for H.264)
          const evenWidth720 = width720 % 2 === 0 ? width720 : width720 - 1;
          const evenHeight720 = height720 % 2 === 0 ? height720 : height720 - 1;
          const evenWidth480 = width480 % 2 === 0 ? width480 : width480 - 1;
          const evenHeight480 = height480 % 2 === 0 ? height480 : height480 - 1;
          
          // Convert to 720p with higher bitrate, preserving aspect ratio
          const cmd720p = `ffmpeg -i "${uploadedFile.tempFilePath}" -c:v libx264 -c:a aac -vf "scale=${evenWidth720}:${evenHeight720}:flags=lanczos" -aspect ${videoInfo.width}:${videoInfo.height} -b:v 5000k -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename "${path.join(tempDir, '720p/segment%03d.ts')}" "${path.join(tempDir, '720p/playlist.m3u8')}"`;
          
          // Convert to 480p with higher bitrate, preserving aspect ratio
          const cmd480p = `ffmpeg -i "${uploadedFile.tempFilePath}" -c:v libx264 -c:a aac -vf "scale=${evenWidth480}:${evenHeight480}:flags=lanczos" -aspect ${videoInfo.width}:${videoInfo.height} -b:v 2500k -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename "${path.join(tempDir, '480p/segment%03d.ts')}" "${path.join(tempDir, '480p/playlist.m3u8')}"`;
          
          // Create master playlist with actual dimensions and updated bandwidth
          const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=${evenWidth720}x${evenHeight720}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=${evenWidth480}x${evenHeight480}
480p/playlist.m3u8`;
          
          fs.writeFileSync(path.join(tempDir, 'master.m3u8'), masterPlaylist);
          
          // Execute both conversions in parallel
          Promise.all([
            execAsync(cmd720p),
            execAsync(cmd480p)
          ]).then(() => resolve()).catch(reject);
          return;
        }
        
        execAsync(ffmpegCommand)
          .then(() => {
            console.log('[SUCCESS] HLS conversion completed');
            resolve();
          })
          .catch((err) => {
            console.error('[ERROR] HLS conversion failed:', err);
            reject(err);
          });
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
        cid: cid
      });

    } catch (leitherError) {
      console.error('[FATAL] Leither service error:', leitherError);
      console.timeEnd('leither-total-time');
      
      res.json({
        success: false,
        message: 'Video converted to HLS successfully, but Leither service failed',
        error: leitherError.message
      });
    }

  } catch (error) {
    console.error('[FATAL] An unexpected error occurred in /convert-video route:', error);
    
    // tempDir might not be defined if error is early, so check for it.
    if (typeof tempDir !== 'undefined' && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`[CLEANUP] Cleaned up temporary directory: ${tempDir}`);
      } catch (cleanupError) {
        console.error('[ERROR] Failed to cleanup temporary directory:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Failed to process video due to a server error.',
      error: error.message
    });
  } finally {
    console.log(`[INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
    console.log(`[${new Date().toISOString()}] --- /convert-video route processing finished ---\n`);
  }
});

module.exports = router; 