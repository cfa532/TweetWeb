const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
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
let hardwareDetectionInFlight = null; // singleflight guard

// Leither connection management is now handled in app.js

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

// Leither connection functions are now available globally from app.js

// Helper function to safely escape file paths for shell commands
function escapeShellArg(arg) {
  return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

// Helper function to execute commands with fallback for COPY preset failures
async function executeWithProgressWithFallback(command, fallbackCommand, jobId, startProgress, endProgress, message, useCopy = false, fileSize = 0) {
  try {
    return await executeWithProgress(command, jobId, startProgress, endProgress, message, fileSize);
  } catch (error) {
    if (useCopy && error.message.includes('Command exited with code')) {
      console.log(`[${jobId}] [FALLBACK] COPY preset failed, retrying with normal encoding: ${error.message}`);
      return await executeWithProgress(fallbackCommand, jobId, startProgress, endProgress, `${message} (fallback)`, fileSize);
    }
    throw error;
  }
}

// Helper function to execute long-running commands with progress updates
function executeWithProgress(command, jobId, startProgress, endProgress, message, fileSize = 0) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] [PROGRESS] Starting ${message} (${startProgress}% - ${endProgress}%)`);
    
    const startTime = Date.now();
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      
      const timeProgress = Math.min(elapsed / (5 * 60 * 1000), 1);
      const currentProgress = Math.floor(startProgress + (endProgress - startProgress) * timeProgress);
      
      processingJobs.set(jobId, {
        ...processingJobs.get(jobId),
        progress: currentProgress,
        message: `${message} (${minutes}m ${seconds}s elapsed)`
      });
      
      console.log(`[${jobId}] [PROGRESS] ${message}: ${currentProgress}% (${minutes}m ${seconds}s elapsed)`);
    }, 5000); // Update progress every 5 seconds for better responsiveness

    // Spawn ffmpeg instead of exec to avoid large stdout buffering
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'ignore', 'pipe'] });

    // Add dynamic timeout for FFmpeg commands based on file size
    // For small files (<10MB): 10 minutes
    // For medium files (10MB-100MB): 30 minutes  
    // For large files (100MB-1GB): 2 hours
    // For very large files (>1GB): 4 hours
    let timeoutMs;
    if (fileSize < 10 * 1024 * 1024) {
      timeoutMs = 10 * 60 * 1000; // 10 minutes for small files
    } else if (fileSize < 100 * 1024 * 1024) {
      timeoutMs = 30 * 60 * 1000; // 30 minutes for medium files
    } else if (fileSize < 1024 * 1024 * 1024) {
      timeoutMs = 2 * 60 * 60 * 1000; // 2 hours for large files (1GB)
    } else {
      timeoutMs = 4 * 60 * 60 * 1000; // 4 hours for very large files (>1GB)
    }
    console.log(`[${jobId}] [TIMEOUT] File size: ${(fileSize / (1024 * 1024)).toFixed(2)}MB, Timeout: ${timeoutMs / (60 * 1000)} minutes`);
    const timeoutId = setTimeout(() => {
      console.log(`[${jobId}] [TIMEOUT] FFmpeg command timed out after ${timeoutMs / 60000} minutes, killing process`);
      child.kill('SIGKILL');
      clearInterval(progressInterval);
      reject(new Error(`FFmpeg command timed out after ${timeoutMs / 60000} minutes`));
    }, timeoutMs);

    let stderrBuffer = '';
    child.stderr.on('data', (chunk) => {
      // Keep minimal stderr to avoid memory pressure
      if (stderrBuffer.length < 10000) {
        stderrBuffer += chunk.toString();
      }
    });

    child.on('error', (error) => {
      clearInterval(progressInterval);
      clearTimeout(timeoutId); // Clear the timeout
      console.error(`[${jobId}] [PROGRESS] ${message} failed to start:`, error.message);
      reject(error);
    });

    child.on('close', (code) => {
      clearInterval(progressInterval);
      clearTimeout(timeoutId); // Clear the timeout
      if (code === 0) {
        console.log(`[${jobId}] [PROGRESS] ${message} completed successfully`);
        resolve({ code, stderr: stderrBuffer });
      } else {
        const err = new Error(`Command exited with code ${code}. Error details: ${stderrBuffer}`);
        console.error(`[${jobId}] [PROGRESS] ${message} failed:`, err.message);
        console.error(`[${jobId}] [FFMPEG] Full stderr output:`, stderrBuffer);
        reject(err);
      }
    });
  });
}

// Helper function to execute Leither operations with progress updates
function executeLeitherOperationWithProgress(operation, operationName, jobId, startProgress, endProgress, message, timeoutMs = 6 * 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] [LEITHER-PROGRESS] Starting ${message} (${startProgress}% - ${endProgress}%)`);
    
    const startTime = Date.now();
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      
      // Update progress based on elapsed time (rough estimation)
      const timeProgress = Math.min(elapsed / (10 * 60 * 1000), 1); // Assume 10 minutes max for Leither operations
      const currentProgress = Math.floor(startProgress + (endProgress - startProgress) * timeProgress);
      
      processingJobs.set(jobId, {
        ...processingJobs.get(jobId),
        progress: currentProgress,
        message: `${message} (${minutes}m ${seconds}s elapsed)`
      });
      
      console.log(`[${jobId}] [LEITHER-PROGRESS] ${message}: ${currentProgress}% (${minutes}m ${seconds}s elapsed)`);
    }, 10000); // Update every 10 seconds for Leither operations
    
    const timeoutPromise = new Promise((_, timeoutReject) => 
      setTimeout(() => {
        clearInterval(progressInterval);
        timeoutReject(new Error(`${operationName} timeout after ${Math.round(timeoutMs / (60 * 1000))} minutes`));
      }, timeoutMs)
    );
    
    Promise.race([operation(), timeoutPromise])
      .then((result) => {
        clearInterval(progressInterval);
        console.log(`[${jobId}] [LEITHER-PROGRESS] ${message} completed successfully`);
        resolve(result);
      })
      .catch((error) => {
        clearInterval(progressInterval);
        console.error(`[${jobId}] [LEITHER-PROGRESS] ${message} failed:`, error.message);
        reject(error);
      });
  });
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
  if (hardwareEncoderCache && (Date.now() - hardwareEncoderCacheTime) < HARDWARE_CACHE_DURATION) {
    console.log('[HARDWARE] Using cached encoder detection');
    return Promise.resolve(hardwareEncoderCache);
  }

  if (hardwareDetectionInFlight) {
    console.log('[HARDWARE] Reusing in-flight encoder detection');
    return hardwareDetectionInFlight;
  }

  console.log('[HARDWARE] Detecting available hardware encoders...');
  const command = 'ffmpeg -hide_banner -encoders | grep -E "(h264_nvenc|h264_qsv|h264_videotoolbox|h264_amf)"';
  console.log('[HARDWARE] Running command:', command);

  hardwareDetectionInFlight = execAsync(command, { timeout: 10000 })
    .then(result => {
      console.log('[HARDWARE] Encoder detection command completed');
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
      return available;
    })
    .catch((error) => {
      console.log('[HARDWARE] No hardware encoders detected, using software encoding. Error:', error.message);
      const available = { nvidia: false, intel: false, apple: false, amd: false };
      hardwareEncoderCache = available;
      hardwareEncoderCacheTime = Date.now();
      return available;
    })
    .finally(() => {
      // allow new detections after fulfillment
      hardwareDetectionInFlight = null;
    });

  return hardwareDetectionInFlight;
}

// Helper function to test if a hardware encoder actually works
function testHardwareEncoder(encoder) {
  return new Promise((resolve) => {
    const testCommand = `ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=1 -c:v ${encoder} -f null - 2>&1`;
    console.log(`[HARDWARE] Testing encoder ${encoder} with command: ${testCommand}`);
    
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
  console.log('[HARDWARE] Getting optimal encoder for:', availableEncoders);
  const is10Bit = videoInfo && videoInfo.bitDepth && videoInfo.bitDepth > 8;
  console.log('[HARDWARE] Video is 10-bit:', is10Bit);
  
  // Check if video resolution is no bigger than target resolution to use COPY preset
  let useCopyPreset = false;
  if (videoInfo) {
    const displayWidth = videoInfo.displayWidth || videoInfo.width;
    const displayHeight = videoInfo.displayHeight || videoInfo.height;
    const isPortrait = displayHeight > displayWidth;
    
    // Check if video codec is HLS-compatible for COPY preset
    const videoCodec = videoInfo.codec || '';
    const isHLSCompatibleCodec = videoCodec.includes('h264') || videoCodec.includes('avc') || videoCodec.includes('hevc');
    
    // Additional check: MPEG4 and other codecs are not HLS-compatible with COPY
    const isIncompatibleCodec = videoCodec.includes('mpeg4') || videoCodec.includes('divx') || videoCodec.includes('xvid');
    const finalHLSCompatible = isHLSCompatibleCodec && !isIncompatibleCodec;
    
    // For landscape: check width ≤ 1280 (x-dimension)
    // For portrait: check height ≤ 1280 (y-dimension)
    // Also check if codec is HLS-compatible
    if (isPortrait) {
      useCopyPreset = displayHeight <= 1280 && finalHLSCompatible;
      console.log(`[HARDWARE] Portrait video: ${displayWidth}x${displayHeight}, codec: ${videoCodec} - COPY preset: ${useCopyPreset} (height ≤ 1280: ${displayHeight <= 1280}, HLS-compatible: ${finalHLSCompatible})`);
    } else {
      useCopyPreset = displayWidth <= 1280 && finalHLSCompatible;
      console.log(`[HARDWARE] Landscape video: ${displayWidth}x${displayHeight}, codec: ${videoCodec} - COPY preset: ${useCopyPreset} (width ≤ 1280: ${displayWidth <= 1280}, HLS-compatible: ${finalHLSCompatible})`);
    }
  }
  
  if (useCopyPreset) {
    console.log('[HARDWARE] Video resolution ≤1280p and HLS-compatible codec, using COPY encoder for optimal performance');
    return {
      encoder: 'copy',
      preset: '', // No preset for copy encoder
      profile: '', // No profile for copy encoder
      level: '', // No level for copy encoder
      hardware: false,
      is10Bit: is10Bit,
      useCopy: true
    };
  }
  
  if (availableEncoders.nvidia) {
    console.log('[HARDWARE] Testing NVIDIA encoder...');
    const nvidiaWorks = await testHardwareEncoder('h264_nvenc');
    if (nvidiaWorks) {
      console.log('[HARDWARE] NVIDIA encoder works, using it');
      return {
        encoder: 'h264_nvenc',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit,
        useCopy: false
      };
    }
  }
  
  if (availableEncoders.intel) {
    console.log('[HARDWARE] Testing Intel encoder...');
    const intelWorks = await testHardwareEncoder('h264_qsv');
    if (intelWorks) {
      console.log('[HARDWARE] Intel encoder works, using it');
      return {
        encoder: 'h264_qsv',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit,
        useCopy: false
      };
    }
  }
  
  if (availableEncoders.apple) {
    console.log('[HARDWARE] Testing Apple encoder...');
    const appleWorks = await testHardwareEncoder('h264_videotoolbox');
    if (appleWorks) {
      console.log('[HARDWARE] Apple encoder works, using it');
      return {
        encoder: 'h264_videotoolbox',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit,
        useCopy: false
      };
    }
  }
  
  if (availableEncoders.amd) {
    console.log('[HARDWARE] Testing AMD encoder...');
    const amdWorks = await testHardwareEncoder('h264_amf');
    if (amdWorks) {
      console.log('[HARDWARE] AMD encoder works, using it');
      return {
        encoder: 'h264_amf',
        preset: 'fast',
        profile: is10Bit ? 'high' : 'main',
        level: '4.1',
        hardware: true,
        is10Bit: is10Bit,
        useCopy: false
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
    is10Bit: is10Bit,
    useCopy: false
  };
}

// Helper function to calculate aspect-ratio-preserving dimensions for single quality conversion
function calculateSingleQualityDimensions(videoInfo, targetDimension = 720) {
  const displayWidth = videoInfo.displayWidth || videoInfo.width;
  const displayHeight = videoInfo.displayHeight || videoInfo.height;
  
  console.log(`[ASPECT-RATIO] Original video dimensions: ${displayWidth}x${displayHeight}`);
  
  // Calculate exact aspect ratio
  const aspectRatio = displayWidth / displayHeight;
  console.log(`[ASPECT-RATIO] Original aspect ratio: ${aspectRatio.toFixed(6)}`);
  
  let targetWidth, targetHeight;
  if (displayHeight > displayWidth) {
    // Portrait video - maintain height, calculate width
    targetHeight = targetDimension;
    targetWidth = Math.round((targetHeight * displayWidth) / displayHeight);
  } else {
    // Landscape video - maintain width, calculate height  
    targetWidth = targetDimension;
    targetHeight = Math.round((targetWidth * displayHeight) / displayWidth);
  }
  
  // Verify aspect ratio is preserved
  const newAspectRatio = targetWidth / targetHeight;
  const aspectRatioDifference = Math.abs(aspectRatio - newAspectRatio);
  console.log(`[ASPECT-RATIO] Target dimensions: ${targetWidth}x${targetHeight}`);
  console.log(`[ASPECT-RATIO] New aspect ratio: ${newAspectRatio.toFixed(6)}`);
  console.log(`[ASPECT-RATIO] Aspect ratio difference: ${aspectRatioDifference.toFixed(6)}`);
  
  if (aspectRatioDifference > 0.001) {
    console.warn(`[ASPECT-RATIO] WARNING: Aspect ratio changed by ${aspectRatioDifference.toFixed(6)}`);
  }
  
  const result = ensureEvenDimensions(targetWidth, targetHeight);
  const finalAspectRatio = result.width / result.height;
  console.log(`[ASPECT-RATIO] Final dimensions: ${result.width}x${result.height}, Final aspect ratio: ${finalAspectRatio.toFixed(6)}`);
  
  return result;
}

// Helper function to create HLS conversion commands
function createHLSConversionCommands(inputPath, tempDir, videoInfo, encoderConfig) {
  const commands = [];
  
  fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });
  
  // Get file size for optimization
  const fileSize = fs.statSync(inputPath).size;
  const isSmallFile = fileSize < 10 * 1024 * 1024; // Less than 10MB
  console.log(`[HLS-CONVERSION] File size: ${(fileSize / (1024 * 1024)).toFixed(2)}MB, Small file optimization: ${isSmallFile}`);
  
  const displayWidth = videoInfo.displayWidth || videoInfo.width;
  const displayHeight = videoInfo.displayHeight || videoInfo.height;

  console.log(`[ASPECT-RATIO] Multi-quality - Original dimensions: ${displayWidth}x${displayHeight}`);
  
  // Calculate exact aspect ratio
  const aspectRatio = displayWidth / displayHeight;
  console.log(`[ASPECT-RATIO] Multi-quality - Original aspect ratio: ${aspectRatio.toFixed(6)}`);

  let targetWidth720, targetHeight720, targetWidth480, targetHeight480;
  if (displayHeight > displayWidth) {
    // Portrait video - maintain height, calculate width
    targetHeight720 = 720;
    targetWidth720 = Math.round((720 * displayWidth) / displayHeight);
    targetHeight480 = 480;
    targetWidth480 = Math.round((480 * displayWidth) / displayHeight);
  } else {
    // Landscape video - maintain width, calculate height
    targetWidth720 = 720;
    targetHeight720 = Math.round((720 * displayHeight) / displayWidth);
    targetWidth480 = 480;
    targetHeight480 = Math.round((480 * displayHeight) / displayWidth);
  }
  
  // Verify aspect ratio preservation for both qualities
  const aspect720 = targetWidth720 / targetHeight720;
  const aspect480 = targetWidth480 / targetHeight480;
  const diff720 = Math.abs(aspectRatio - aspect720);
  const diff480 = Math.abs(aspectRatio - aspect480);
  
  console.log(`[ASPECT-RATIO] 720p: ${targetWidth720}x${targetHeight720}, aspect ratio: ${aspect720.toFixed(6)}, diff: ${diff720.toFixed(6)}`);
  console.log(`[ASPECT-RATIO] 480p: ${targetWidth480}x${targetHeight480}, aspect ratio: ${aspect480.toFixed(6)}, diff: ${diff480.toFixed(6)}`);
  
  // Additional verification for 480p specifically
  const original480Ratio = displayWidth / displayHeight;
  const calculated480Ratio = targetWidth480 / targetHeight480;
  console.log(`[ASPECT-RATIO] 480p VERIFICATION - Original: ${original480Ratio.toFixed(6)}, Calculated: ${calculated480Ratio.toFixed(6)}, Match: ${Math.abs(original480Ratio - calculated480Ratio) < 0.001 ? 'YES' : 'NO'}`);
  
  if (diff720 > 0.001 || diff480 > 0.001) {
    console.warn(`[ASPECT-RATIO] WARNING: Aspect ratio changed significantly in multi-quality conversion`);
  }

  const dim720 = ensureEvenDimensions(targetWidth720, targetHeight720);
  const dim480 = ensureEvenDimensions(targetWidth480, targetHeight480);

  const isDisplayPortrait = displayHeight > displayWidth;
  // Use original bitrate if it's lower than our target bitrates
  // For streaming, cap at reasonable limits to prevent buffer stalls
  const maxStreamingBitrate720 = 3000; // Cap at 3Mbps for better streaming
  const maxStreamingBitrate480 = 1500; // Cap at 1.5Mbps for better streaming
  
  const originalBitrate720 = videoInfo && videoInfo.bitrate ? Math.min(maxStreamingBitrate720, Math.floor(videoInfo.bitrate / 1000)) : maxStreamingBitrate720;
  const originalBitrate480 = videoInfo && videoInfo.bitrate ? Math.min(maxStreamingBitrate480, Math.floor(videoInfo.bitrate / 1000)) : maxStreamingBitrate480;
  
  const bitrate720 = originalBitrate720; // Use original bitrate if lower, otherwise use capped value
  const bitrate480 = originalBitrate480; // Use original bitrate if lower, otherwise use capped value
  
  // Calculate optimal segment durations for each quality
  const segmentDuration720 = calculateOptimalSegmentDuration(videoInfo, bitrate720);
  const segmentDuration480 = calculateOptimalSegmentDuration(videoInfo, bitrate480);
  
  console.log(`[HLS-CONVERSION] Using bitrates - 720p: ${bitrate720}k, 480p: ${bitrate480}k (original: ${videoInfo && videoInfo.bitrate ? (videoInfo.bitrate / 1000).toFixed(0) + 'k' : 'unknown'})`);
  console.log(`[HLS-CONVERSION] Using segment durations - 720p: ${segmentDuration720}s, 480p: ${segmentDuration480}s`);

  // IMPORTANT: For multi-quality conversion, NEVER use copy encoder
  // Copy encoder cannot scale video, so both streams would be identical
  // Override useCopy to false for multi-quality scenarios
  if (encoderConfig.useCopy) {
    console.log('[HLS-CONVERSION] Multi-quality conversion detected - overriding COPY encoder to ensure proper scaling');
    encoderConfig = {
      ...encoderConfig,
      useCopy: false,
      encoder: encoderConfig.hardware ? encoderConfig.encoder : 'libx264',
      preset: encoderConfig.hardware ? encoderConfig.preset : 'fast' // Ensure preset is set for software encoding
    };
  }

  const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder, encoderConfig.is10Bit) : '';
  
  // Software encoder parameters (only for libx264)
  const softwareParams = encoderConfig.hardware ? '' : `-preset ${encoderConfig.preset || 'fast'} -tune zerolatency -threads 2`;
  
  console.log(`[HLS-CONVERSION] Encoder: ${encoderConfig.encoder}, Hardware: ${encoderConfig.hardware}, HW Params: "${hwParams}", SW Params: "${softwareParams}"`);

  // Ensure parameters are properly formatted with spaces
  const formattedHwParams = hwParams ? ` ${hwParams}` : '';
  const formattedSoftwareParams = softwareParams ? ` ${softwareParams}` : '';

  // Use optimized commands for small files
  let cmd720p, cmd480p;
  
  if (isSmallFile) {
    // Simplified commands for small files (faster processing)
    console.log('[HLS-CONVERSION] Using optimized commands for small file');
    cmd720p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder}${formattedHwParams} -c:a aac -vf "scale=${dim720.width}:${dim720.height}" -b:v ${bitrate720}k -b:a 128k${formattedSoftwareParams} -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
    cmd480p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder}${formattedHwParams} -c:a aac -vf "scale=${dim480.width}:${dim480.height}" -b:v ${bitrate480}k -b:a 128k${formattedSoftwareParams} -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '480p/segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, '480p/playlist.m3u8'))}`;
  } else {
    // Full commands for larger files
    console.log('[HLS-CONVERSION] Using full commands for large file');
    cmd720p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder}${formattedHwParams} -c:a aac -vf "scale=${dim720.width}:${dim720.height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" -b:v ${bitrate720}k -b:a 128k${formattedSoftwareParams} -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -bufsize ${bitrate720}k -maxrate ${bitrate720}k -g 30 -keyint_min 30 -sc_threshold 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
    cmd480p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder}${formattedHwParams} -c:a aac -vf "scale=${dim480.width}:${dim480.height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" -b:v ${bitrate480}k -b:a 128k${formattedSoftwareParams} -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -bufsize ${bitrate480}k -maxrate ${bitrate480}k -g 30 -keyint_min 30 -sc_threshold 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '480p/segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, '480p/playlist.m3u8'))}`;
  }

  commands.push(cmd720p, cmd480p);
  
  const bandwidth720 = 2000000; // Match Swift: 2000000
  const bandwidth480 = 1000000; // Match Swift: 1000000
  
  const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth720},RESOLUTION=${dim720.width}x${dim720.height}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth480},RESOLUTION=${dim480.width}x${dim480.height}
480p/playlist.m3u8`;
  
  fs.writeFileSync(path.join(tempDir, 'master.m3u8'), masterPlaylist);
  
  return commands;
}

// Helper function to calculate optimal HLS segment duration based on video characteristics
function calculateOptimalSegmentDuration(videoInfo, bitrate) {
  const width = videoInfo.displayWidth || videoInfo.width;
  const height = videoInfo.displayHeight || videoInfo.height;
  const resolution = width * height;
  
  // Base segment duration
  let segmentDuration = 6; // Default 6 seconds
  
  // Adjust based on resolution
  if (resolution >= 1920 * 1080) {
    // 1080p and higher: longer segments for better compression
    segmentDuration = 12;
  } else if (resolution >= 1280 * 720) {
    // 720p: medium segments
    segmentDuration = 10;
  } else if (resolution >= 854 * 480) {
    // 480p: shorter segments
    segmentDuration = 8;
  } else {
    // Lower resolution: shortest segments
    segmentDuration = 6;
  }
  
  // Adjust based on bitrate (higher bitrate = longer segments)
  if (bitrate > 2000) {
    segmentDuration = Math.min(segmentDuration + 2, 15); // Cap at 15 seconds
  } else if (bitrate < 500) {
    segmentDuration = Math.max(segmentDuration - 2, 4); // Cap at 4 seconds
  }
  
  console.log(`[HLS-SEGMENTS] Resolution: ${width}x${height}, Bitrate: ${bitrate}k, Segment duration: ${segmentDuration}s`);
  return segmentDuration;
}

// Helper function to get hardware-specific encoding parameters
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

// Main video processing function
async function processVideoUpload(req, res) {
  const routeStartTime = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  console.log(`\n[${new Date().toISOString()}] [${requestId}] --- /convert-video route processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;
  let leitherClient = null;
  
  // Set proper headers to keep connection alive
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=21600, max=1000'); // 6 hours timeout

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

    const maxFileSize = 4 * 1024 * 1024 * 1024; // 4GB
    if (uploadedFile.size > maxFileSize) {
      console.error(`[${requestId}] [ERROR] File size ${uploadedFile.size} exceeds limit of ${maxFileSize}`);
      return res.status(400).json({
        success: false,
        message: `File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 4GB.`
      });
    }

    const noResample = req.body.noResample === 'true' || req.body.noResample === true;
    console.log(`[${requestId}] [INFO] noResample parameter: ${noResample}`);

    const allowedTypes = [
      'video/mp4', 'video/avi', 'video/mov', 'video/quicktime', 'video/mkv', 
      'video/wmv', 'video/flv', 'video/webm', 'video/x-msvideo', 
      'video/x-matroska', 'video/x-ms-wmv', 'video/x-flv', 'video/3gpp', 'video/ogg'
    ];
    const allowedExtensions = ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ogv'];
    const fileExtension = uploadedFile.name.toLowerCase().split('.').pop();
    
    // If MIME type is empty or generic, try to detect from extension
    let detectedMimeType = uploadedFile.mimetype;
    if (!detectedMimeType || detectedMimeType === 'application/octet-stream' || detectedMimeType === '') {
      console.log(`[${requestId}] [DEBUG] MIME type is empty or generic, detecting from extension: ${fileExtension}`);
      const mimeTypeMap = {
        'mp4': 'video/mp4',
        'avi': 'video/avi',
        'mov': 'video/quicktime',
        'mkv': 'video/x-matroska',
        'wmv': 'video/x-ms-wmv',
        'flv': 'video/x-flv',
        'webm': 'video/webm',
        'm4v': 'video/mp4',
        '3gp': 'video/3gpp',
        'ogv': 'video/ogg'
      };
      detectedMimeType = mimeTypeMap[fileExtension] || 'video/mp4';
      console.log(`[${requestId}] [DEBUG] Detected MIME type: ${detectedMimeType}`);
    }
    
    const isValidType = allowedTypes.includes(detectedMimeType) || 
                        allowedExtensions.includes(fileExtension);
    
    if (!isValidType) {
      console.error(`[${requestId}] [ERROR] Unsupported video type: '${detectedMimeType}' (original: '${uploadedFile.mimetype}') with extension '.${fileExtension}'.`);
      return res.status(400).json({
        success: false,
        message: `Invalid video type. Detected: ${detectedMimeType}, Extension: .${fileExtension}. Allowed types are: ${allowedTypes.join(', ')}`
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
                
                // Extract bitrate information
                const bitrate = videoStream.bit_rate ? parseInt(videoStream.bit_rate) : null;
                const formatBitrate = metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null;
                const originalBitrate = bitrate || formatBitrate;
                
                console.log(`[${requestId}] [INFO] Original video bitrate: ${originalBitrate ? (originalBitrate / 1000).toFixed(0) + 'k' : 'unknown'}`);
                
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
                  codec: videoStream.codec_name,
                  bitrate: originalBitrate
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
    
    // Check file size to determine conversion strategy
    const fileSizeMB = uploadedFile.size / (1024 * 1024);
    const useSingleQuality = fileSizeMB > 256; // Use single quality for files > 256MB
    
    if (noResample) {
      const ffmpegCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v copy -c:a copy -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      
      await executeWithProgress(ffmpegCommand, requestId, 0, 50, 'Converting video to HLS format...', uploadedFile.size);
      console.log(`[${requestId}] [SUCCESS] HLS conversion completed`);
    } else if (useSingleQuality) {
      // For large files (>256MB), use single quality 720p conversion to save memory
      console.log(`[${requestId}] [INFO] Large file detected (${fileSizeMB.toFixed(2)}MB), using single-quality 720p conversion`);
      
      const availableEncoders = await detectHardwareEncoders();
      const encoderConfig = await getOptimalEncoder(availableEncoders, videoInfo);
      console.log(`[${requestId}] [HARDWARE] Using encoder: ${encoderConfig.encoder} (hardware: ${encoderConfig.hardware})`);
      
      // Calculate aspect-ratio-preserving dimensions for 720p
      const dim720 = calculateSingleQualityDimensions(videoInfo, 720);
      console.log(`[${requestId}] [INFO] Original dimensions: ${videoInfo.width}x${videoInfo.height}, Target dimensions: ${dim720.width}x${dim720.height}`);
      
      // Calculate optimal bitrate based on original video bitrate
      // Cap at 3Mbps for better streaming performance
      const maxStreamingBitrate = 3000;
      const originalBitrate720 = videoInfo && videoInfo.bitrate ? Math.min(maxStreamingBitrate, Math.floor(videoInfo.bitrate / 1000)) : maxStreamingBitrate;
      console.log(`[${requestId}] [BITRATE] Using 720p bitrate: ${originalBitrate720}k (original: ${videoInfo && videoInfo.bitrate ? (videoInfo.bitrate / 1000).toFixed(0) + 'k' : 'unknown'})`);
      
      // Get hardware-specific parameters
      const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder, encoderConfig.is10Bit) : '';
      const softwareParams = encoderConfig.hardware ? '' : '-preset fast -tune zerolatency -threads 2';
      
      console.log(`[${requestId}] [ENCODER-INFO] Using encoder: ${encoderConfig.encoder}, Hardware: ${encoderConfig.hardware}, HW Params: "${hwParams}", SW Params: "${softwareParams}"`);
      
      let singleQualityCommand;
      if (encoderConfig.useCopy) {
        // Use COPY encoder with HLS compatibility parameters
        console.log(`[${requestId}] [HLS-CONVERSION] Using COPY encoder for single quality conversion with HLS compatibility parameters`);
        singleQualityCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v copy -c:a aac -b:a 128k -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      } else {
        // Use normal encoding with scaling and HLS compatibility parameters
        // Ensure softwareParams is properly formatted with spaces
        const formattedSoftwareParams = softwareParams ? ` ${softwareParams}` : '';
        singleQualityCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v ${encoderConfig.encoder}${hwParams ? ` ${hwParams}` : ''} -c:a aac -vf "scale=${dim720.width}:${dim720.height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" -b:v ${originalBitrate720}k -b:a 128k${formattedSoftwareParams} -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -bufsize ${originalBitrate720}k -maxrate ${originalBitrate720}k -g 30 -keyint_min 30 -sc_threshold 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      }
      
      console.log(`[${requestId}] [FFMPEG] Starting single-quality conversion for large file: ${singleQualityCommand}`);
      
      // Create fallback command for COPY preset failures
      const fallbackCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v libx264 -c:a aac -vf "scale=${dim720.width}:${dim720.height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" -b:v ${originalBitrate720}k -b:a 128k -preset fast -tune zerolatency -threads 2 -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -bufsize ${originalBitrate720}k -maxrate ${originalBitrate720}k -g 30 -keyint_min 30 -sc_threshold 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      
      await executeWithProgressWithFallback(singleQualityCommand, fallbackCommand, requestId, 0, 50, 'Converting large video to 720p HLS...', encoderConfig.useCopy, uploadedFile.size);
      console.log(`[${requestId}] [SUCCESS] Single-quality HLS conversion completed`);
    } else {
      // For smaller files, use multi-quality conversion
      const availableEncoders = await detectHardwareEncoders();
      const encoderConfig = await getOptimalEncoder(availableEncoders, videoInfo);
      console.log(`[${requestId}] [HARDWARE] Using encoder: ${encoderConfig.encoder} (hardware: ${encoderConfig.hardware})`);
      
      const commands = createHLSConversionCommands(uploadedFile.tempFilePath, tempDir, videoInfo, encoderConfig);
      
      // Note: Copy encoder is never used in multi-quality conversion (handled in createHLSConversionCommands)
      // So no fallback is needed here - copy encoder fallback is only for single-quality scenarios
      
      await Promise.all([
        executeWithProgress(commands[0], requestId, 0, 25, 'Converting video to 720p HLS...', uploadedFile.size),
        executeWithProgress(commands[1], requestId, 25, 50, 'Converting video to 480p HLS...', uploadedFile.size)
      ]);
      console.log(`[${requestId}] [SUCCESS] Multi-quality HLS conversion completed`);
    }
    
    console.timeEnd(`[${requestId}] hls-conversion`);

    // Process with Leither
    console.log(`\n[${requestId}] [STEP 5] Processing with Leither service...`);
    console.time(`[${requestId}] leither-total-time`);
    let timingLabels = new Set();
    
    try {
      console.time(`[${requestId}] leither-port-detection`);
      timingLabels.add('leither-port-detection');
      const leitherPort = global.getCurrentLeitherPort();
      console.timeEnd(`[${requestId}] leither-port-detection`);
      timingLabels.delete('leither-port-detection');
      console.log(`[${requestId}] [INFO] Using Leither service on port: ${leitherPort}`);

      leitherClient = await global.getLeitherConnection();
      
      console.time(`[${requestId}] leither-get-ppt`);
      timingLabels.add('leither-get-ppt');
      console.log(`[${requestId}] [INFO] Getting PPT from Leither service...`);
      
      const executeLeitherOperation = async (operation, operationName, timeoutMs = 6 * 60 * 60 * 1000) => {
        try {
          console.log(`[${requestId}] [LEITHER] ${operationName}`);
          const result = await Promise.race([
            operation(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`${operationName} timeout after ${Math.round(timeoutMs / (60 * 1000))} minutes`)), timeoutMs)
            )
          ]);
          console.log(`[${requestId}] [LEITHER] ${operationName} completed successfully`);
          return result;
        } catch (error) {
          console.error(`[${requestId}] [LEITHER] ${operationName} failed:`, error.message);
          throw error;
        }
      };
      
      const leitherVersion = await executeLeitherOperation(
        () => leitherClient.Getvar("", "ver"),
        "Getvar version",
        30000 // 30 seconds for version check
      );
      console.log(`[${requestId}] [DEBUG] Leither version: ${leitherVersion}`);
      
      const ppt = await executeLeitherOperation(
        () => leitherClient.GetVarByContext("", "context_ppt", []),
        "GetVarByContext PPT",
        60000 // 1 minute for PPT retrieval
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
        "Login",
        60000 // 1 minute for login
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
      console.log(`[${requestId}] [DEBUG] Starting IPFS add operation...`);
      let cid;
      try {
        cid = await executeLeitherOperation(
          () => leitherClient.IpfsAdd(api.sid, tempDir),
          "IpfsAdd",
          6 * 60 * 60 * 1000 // 6 hours for IPFS add (can be very large)
        );
        leitherClient.timeout = defaultTimeout;
        console.timeEnd(`[${requestId}] leither-ipfs-add`);
        timingLabels.delete('leither-ipfs-add');
        console.log(`[${requestId}] [DEBUG] IPFS add operation completed, result:`, cid);
        console.log(`[${requestId}] [DEBUG] CID type:`, typeof cid, 'Value:', cid);
        console.log(`[${requestId}] [SUCCESS] IPFS CID received:`, cid);
      } catch (ipfsError) {
        console.error(`[${requestId}] [ERROR] IPFS add operation failed:`, ipfsError);
        throw ipfsError;
      }

      console.timeEnd(`[${requestId}] leither-total-time`);
      timingLabels.delete('leither-total-time');
      
      // Send response with proper headers to ensure delivery
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(JSON.stringify({
        success: true,
        message: 'Video converted to HLS and added to IPFS successfully',
        cid: cid,
        tempDir: tempDir
      })));
      
      res.end(JSON.stringify({
        success: true,
        message: 'Video converted to HLS and added to IPFS successfully',
        cid: cid,
        tempDir: tempDir
      }));

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
      
      // Send error response with proper headers
      const errorResponse = JSON.stringify({
        success: false,
        message: errorMessage,
        error: leitherError.message,
        tempDir: tempDir
      });
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(errorResponse));
      res.end(errorResponse);
    }

  } catch (error) {
    console.error(`[${requestId}] [FATAL] An unexpected error occurred in /convert-video route:`, error);

    // Send error response with proper headers
    const errorResponse = JSON.stringify({
      success: false,
      message: 'Failed to process video due to a server error.',
      error: error.message,
      tempDir: tempDir
    });
    
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', Buffer.byteLength(errorResponse));
    res.end(errorResponse);
  } finally {
    if (leitherClient) {
      global.releaseLeitherConnection(leitherClient);
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

// Internal video processing function (no response object)
async function processVideoUploadInternal(req, jobId) {
  const routeStartTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] [${jobId}] --- /convert-video internal processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;
  let leitherClient = null;

  try {
    if (activeUploads <= 1) {
      console.log(`[${jobId}] [CLEANUP] Cleaning up old temporary files...`);
      cleanupOldTempFiles();
    }

    // File validation already done in main route handler

    uploadedFile = req.files.videoFile;
    console.log(`[${jobId}] [INFO] Received video: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);

    const maxFileSize = 4 * 1024 * 1024 * 1024; // 4GB
    if (uploadedFile.size > maxFileSize) {
      console.error(`[${jobId}] [ERROR] File size ${uploadedFile.size} exceeds limit of ${maxFileSize}`);
      throw new Error(`File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 4GB.`);
    }

    const noResample = req.body.noResample === 'true' || req.body.noResample === true;
    console.log(`[${jobId}] [INFO] noResample parameter: ${noResample}`);

    const allowedTypes = [
      'video/mp4', 'video/avi', 'video/mov', 'video/quicktime', 'video/mkv', 
      'video/wmv', 'video/flv', 'video/webm', 'video/x-msvideo', 
      'video/x-matroska', 'video/x-ms-wmv', 'video/x-flv', 'video/3gpp', 'video/ogg'
    ];
    const allowedExtensions = ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ogv'];
    const fileExtension = uploadedFile.name.toLowerCase().split('.').pop();
    
    // If MIME type is empty or generic, try to detect from extension
    let detectedMimeType = uploadedFile.mimetype;
    if (!detectedMimeType || detectedMimeType === 'application/octet-stream' || detectedMimeType === '') {
      console.log(`[${jobId}] [DEBUG] MIME type is empty or generic, detecting from extension: ${fileExtension}`);
      const mimeTypeMap = {
        'mp4': 'video/mp4',
        'avi': 'video/avi',
        'mov': 'video/quicktime',
        'mkv': 'video/x-matroska',
        'wmv': 'video/x-ms-wmv',
        'flv': 'video/x-flv',
        'webm': 'video/webm',
        'm4v': 'video/mp4',
        '3gp': 'video/3gpp',
        'ogv': 'video/ogg'
      };
      detectedMimeType = mimeTypeMap[fileExtension] || 'video/mp4';
      console.log(`[${jobId}] [DEBUG] Detected MIME type: ${detectedMimeType}`);
    }
    
    const isValidType = allowedTypes.includes(detectedMimeType) || 
                        allowedExtensions.includes(fileExtension);
    
    if (!isValidType) {
      console.error(`[${jobId}] [ERROR] Unsupported video type: '${detectedMimeType}' (original: '${uploadedFile.mimetype}') with extension '.${fileExtension}'.`);
      throw new Error(`Invalid video type. Detected: ${detectedMimeType}, Extension: .${fileExtension}. Allowed types are: ${allowedTypes.join(', ')}`);
    }

    // Create temporary directory
    tempDir = path.join(os.tmpdir(), `hls-convert-${Date.now()}-${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[${jobId}] [INFO] Created temporary directory: ${tempDir}`);

    // Get video dimensions if resampling is needed
    let videoInfo = null;
    
    if (!noResample) {
      console.log(`\n[${jobId}] [STEP 3] Getting video dimensions for resampling...`);
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
                
                console.log(`[${jobId}] [INFO] Video dimensions: ${videoStream.width}x${videoStream.height}`);
                console.log(`[${jobId}] [INFO] Display dimensions (after rotation): ${displayWidth}x${displayHeight}`);
                console.log(`[${jobId}] [INFO] Rotation: ${rotation} degrees`);
                console.log(`[${jobId}] [INFO] Detected video bit depth: ${bitDepth}-bit`);
                
                // Extract bitrate information
                const bitrate = videoStream.bit_rate ? parseInt(videoStream.bit_rate) : null;
                const formatBitrate = metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null;
                const originalBitrate = bitrate || formatBitrate;
                
                console.log(`[${jobId}] [INFO] Original video bitrate: ${originalBitrate ? (originalBitrate / 1000).toFixed(0) + 'k' : 'unknown'}`);
                
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
                  codec: videoStream.codec_name,
                  bitrate: originalBitrate
                });
              } catch (parseError) {
                console.error(`[${jobId}] [ERROR] Failed to parse ffprobe JSON:`, parseError);
                reject(new Error(`Failed to parse video metadata: ${parseError.message}`));
              }
            })
            .catch(reject);
        });
      };

      videoInfo = await getVideoInfo();
      console.log(`[${jobId}] [INFO] Video dimensions: ${videoInfo.width}x${videoInfo.height}, duration: ${videoInfo.duration}s`);
      
      const displayWidth = videoInfo.displayWidth || videoInfo.width;
      const displayHeight = videoInfo.displayHeight || videoInfo.height;
      console.log(`[${jobId}] [INFO] Display orientation: ${displayHeight > displayWidth ? 'Portrait' : 'Landscape'} (${displayWidth}x${displayHeight})`);
      if (videoInfo.rotation !== 0) {
        console.log(`[${jobId}] [INFO] Video has rotation: ${videoInfo.rotation}°`);
      }
    } else {
      console.log(`\n[${jobId}] [STEP 3] Skipping video dimension analysis (noResample=true)`);
    }

    // Convert to HLS
    console.log(`\n[${jobId}] [STEP 4] Converting video to HLS format...`);
    console.time(`[${jobId}] hls-conversion`);
    
    // Update progress
    processingJobs.set(jobId, {
      ...processingJobs.get(jobId),
      progress: 40,
      message: 'Converting video to HLS format...'
    });
    
    // Check file size to determine conversion strategy
    const fileSizeMB = uploadedFile.size / (1024 * 1024);
    const useSingleQuality = fileSizeMB > 256; // Use single quality for files > 256MB
    
    if (noResample) {
      const ffmpegCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v copy -c:a copy -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      
      console.log(`[${jobId}] [FFMPEG] Starting no-resample conversion with command: ${ffmpegCommand}`);
      await executeWithProgress(ffmpegCommand, jobId, 0, 50, 'Converting video to HLS format...', uploadedFile.size);
      console.log(`[${jobId}] [SUCCESS] HLS conversion completed`);
    } else if (useSingleQuality) {
      // For large files (>500MB), use single quality 720p conversion to save memory
      console.log(`[${jobId}] [INFO] Large file detected (${fileSizeMB.toFixed(2)}MB), using single-quality 720p conversion`);
      
      console.log(`[${jobId}] [HARDWARE] Detecting available encoders...`);
      const availableEncoders = await detectHardwareEncoders();
      console.log(`[${jobId}] [HARDWARE] Available encoders:`, availableEncoders);
      
      console.log(`[${jobId}] [HARDWARE] Getting optimal encoder...`);
      const encoderConfig = await getOptimalEncoder(availableEncoders, videoInfo);
      console.log(`[${jobId}] [HARDWARE] Using encoder: ${encoderConfig.encoder} (hardware: ${encoderConfig.hardware})`);
      
      // Calculate aspect-ratio-preserving dimensions for 720p
      const dim720 = calculateSingleQualityDimensions(videoInfo, 720);
      console.log(`[${jobId}] [INFO] Original dimensions: ${videoInfo.width}x${videoInfo.height}, Target dimensions: ${dim720.width}x${dim720.height}`);
      
      // Calculate optimal bitrate based on original video bitrate
      // Cap at 3Mbps for better streaming performance
      const maxStreamingBitrate = 3000;
      const originalBitrate720 = videoInfo && videoInfo.bitrate ? Math.min(maxStreamingBitrate, Math.floor(videoInfo.bitrate / 1000)) : maxStreamingBitrate;
      console.log(`[${jobId}] [BITRATE] Using 720p bitrate: ${originalBitrate720}k (original: ${videoInfo && videoInfo.bitrate ? (videoInfo.bitrate / 1000).toFixed(0) + 'k' : 'unknown'})`);
      
      // Get hardware-specific parameters
      const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder, encoderConfig.is10Bit) : '';
      const softwareParams = encoderConfig.hardware ? '' : '-preset fast -tune zerolatency -threads 2';
      
      console.log(`[${jobId}] [ENCODER-INFO] Using encoder: ${encoderConfig.encoder}, Hardware: ${encoderConfig.hardware}, HW Params: "${hwParams}", SW Params: "${softwareParams}"`);
      
      let singleQualityCommand;
      if (encoderConfig.useCopy) {
        // Use COPY encoder with HLS compatibility parameters
        console.log(`[${jobId}] [HLS-CONVERSION] Using COPY encoder for single quality conversion with HLS compatibility parameters`);
        singleQualityCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v copy -c:a aac -b:a 128k -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      } else {
        // Use normal encoding with scaling and HLS compatibility parameters
        // Ensure softwareParams is properly formatted with spaces
        const formattedSoftwareParams = softwareParams ? ` ${softwareParams}` : '';
        singleQualityCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v ${encoderConfig.encoder}${hwParams ? ` ${hwParams}` : ''} -c:a aac -vf "scale=${dim720.width}:${dim720.height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" -b:v ${originalBitrate720}k -b:a 128k${formattedSoftwareParams} -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -bufsize ${originalBitrate720}k -maxrate ${originalBitrate720}k -g 30 -keyint_min 30 -sc_threshold 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      }
      
      console.log(`[${jobId}] [FFMPEG] Starting single-quality conversion for large file: ${singleQualityCommand}`);
      
      // Create fallback command for COPY preset failures
      const fallbackCommand = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v libx264 -c:a aac -vf "scale=${dim720.width}:${dim720.height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2" -b:v ${originalBitrate720}k -b:a 128k -preset fast -tune zerolatency -threads 2 -max_muxing_queue_size 1024 -fflags +genpts+igndts -avoid_negative_ts make_zero -max_interleave_delta 0 -bufsize ${originalBitrate720}k -maxrate ${originalBitrate720}k -g 30 -keyint_min 30 -sc_threshold 0 -metadata:s:v:0 rotate=0 -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} -hls_flags independent_segments+discont_start+split_by_time ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
      
      await executeWithProgressWithFallback(singleQualityCommand, fallbackCommand, jobId, 0, 50, 'Converting large video to 720p HLS...', encoderConfig.useCopy, uploadedFile.size);
      console.log(`[${jobId}] [SUCCESS] Single-quality HLS conversion completed`);
    } else {
      // For smaller files, use multi-quality conversion
      console.log(`[${jobId}] [HARDWARE] Detecting available encoders...`);
      const availableEncoders = await detectHardwareEncoders();
      console.log(`[${jobId}] [HARDWARE] Available encoders:`, availableEncoders);
      
      console.log(`[${jobId}] [HARDWARE] Getting optimal encoder...`);
      const encoderConfig = await getOptimalEncoder(availableEncoders, videoInfo);
      console.log(`[${jobId}] [HARDWARE] Using encoder: ${encoderConfig.encoder} (hardware: ${encoderConfig.hardware})`);
      
      console.log(`[${jobId}] [HARDWARE] Creating HLS conversion commands...`);
      const commands = createHLSConversionCommands(uploadedFile.tempFilePath, tempDir, videoInfo, encoderConfig);
      
      console.log(`[${jobId}] [FFMPEG] Starting multi-quality conversion...`);
      console.log(`[${jobId}] [FFMPEG] Command 1: ${commands[0]}`);
      console.log(`[${jobId}] [FFMPEG] Command 2: ${commands[1]}`);
      
      // Note: Copy encoder is never used in multi-quality conversion (handled in createHLSConversionCommands)
      // So no fallback is needed here - copy encoder fallback is only for single-quality scenarios
      
      // Execute both commands with progress tracking
      await Promise.all([
        executeWithProgress(commands[0], jobId, 0, 25, 'Converting video to 720p HLS...', uploadedFile.size),
        executeWithProgress(commands[1], jobId, 25, 50, 'Converting video to 480p HLS...', uploadedFile.size)
      ]);
      console.log(`[${jobId}] [SUCCESS] Multi-quality HLS conversion completed`);
    }
    
    console.timeEnd(`[${jobId}] hls-conversion`);

    // Process with Leither
    console.log(`\n[${jobId}] [STEP 5] Processing with Leither service...`);
    console.time(`[${jobId}] leither-total-time`);
    let timingLabels = new Set();
    
    // Update progress
    processingJobs.set(jobId, {
      ...processingJobs.get(jobId),
      progress: 60,
      message: 'Processing with Leither service...'
    });
    
    try {
      console.time(`[${jobId}] leither-port-detection`);
      timingLabels.add('leither-port-detection');
      const leitherPort = global.getCurrentLeitherPort();
      console.timeEnd(`[${jobId}] leither-port-detection`);
      timingLabels.delete('leither-port-detection');
      console.log(`[${jobId}] [INFO] Using Leither service on port: ${leitherPort}`);

      leitherClient = await global.getLeitherConnection();
      
      console.time(`[${jobId}] leither-get-ppt`);
      timingLabels.add('leither-get-ppt');
      console.log(`[${jobId}] [INFO] Getting PPT from Leither service...`);
      
      const executeLeitherOperation = async (operation, operationName, timeoutMs = 6 * 60 * 60 * 1000) => {
        try {
          console.log(`[${jobId}] [LEITHER] ${operationName}`);
          const result = await Promise.race([
            operation(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`${operationName} timeout after ${Math.round(timeoutMs / (60 * 1000))} minutes`)), timeoutMs)
            )
          ]);
          console.log(`[${jobId}] [LEITHER] ${operationName} completed successfully`);
          return result;
        } catch (error) {
          console.error(`[${jobId}] [LEITHER] ${operationName} failed:`, error.message);
          throw error;
        }
      };
      
      const leitherVersion = await executeLeitherOperation(
        () => leitherClient.Getvar("", "ver"),
        "Getvar version",
        30000 // 30 seconds for version check
      );
      console.log(`[${jobId}] [DEBUG] Leither version: ${leitherVersion}`);
      
      const ppt = await executeLeitherOperation(
        () => leitherClient.GetVarByContext("", "context_ppt", []),
        "GetVarByContext PPT",
        60000 // 1 minute for PPT retrieval
      );
      console.timeEnd(`[${jobId}] leither-get-ppt`);
      timingLabels.delete('leither-get-ppt');
      if (!ppt) throw new Error("Failed to get PPT from Leither service.");
      console.log(`[${jobId}] [SUCCESS] PPT received.`);

      console.time(`[${jobId}] leither-login`);
      timingLabels.add('leither-login');
      console.log(`[${jobId}] [INFO] Logging in to Leither service...`);
      const api = await executeLeitherOperation(
        () => leitherClient.Login(ppt),
        "Login",
        60000 // 1 minute for login
      );
      console.timeEnd(`[${jobId}] leither-login`);
      timingLabels.delete('leither-login');
      if (!api || !api.sid) throw new Error("Login to Leither service failed.");
      console.log(`[${jobId}] [SUCCESS] Login successful. SID:`, api.sid);

      console.time(`[${jobId}] leither-ipfs-add`);
      timingLabels.add('leither-ipfs-add');
      console.log(`[${jobId}] [INFO] Adding HLS content to IPFS from path: '${tempDir}'`);
      
      // Update progress
      processingJobs.set(jobId, {
        ...processingJobs.get(jobId),
        progress: 80,
        message: 'Adding to IPFS...'
      });

      const defaultTimeout = leitherClient.timeout;
      leitherClient.timeout = 0;
      console.log(`[${jobId}] [DEBUG] Starting IPFS add operation...`);
      let cid;
      try {
        cid = await executeLeitherOperationWithProgress(
          () => leitherClient.IpfsAdd(api.sid, tempDir),
          "IpfsAdd",
          jobId,
          50,
          100,
          "Adding to IPFS...",
          6 * 60 * 60 * 1000 // 6 hours for IPFS add (can be very large)
        );
        leitherClient.timeout = defaultTimeout;
        console.timeEnd(`[${jobId}] leither-ipfs-add`);
        timingLabels.delete('leither-ipfs-add');
        console.log(`[${jobId}] [DEBUG] IPFS add operation completed, result:`, cid);
        console.log(`[${jobId}] [DEBUG] CID type:`, typeof cid, 'Value:', cid);
        console.log(`[${jobId}] [SUCCESS] IPFS CID received:`, cid);
      } catch (ipfsError) {
        console.error(`[${jobId}] [ERROR] IPFS add operation failed:`, ipfsError);
        throw ipfsError;
      }

      console.timeEnd(`[${jobId}] leither-total-time`);
      timingLabels.delete('leither-total-time');
      
      return { cid, tempDir };

    } catch (leitherError) {
      console.error(`[${jobId}] [FATAL] Leither service error:`, leitherError);
      
      // Clean up any active timing labels
      const labelsToClean = ['leither-total-time', 'leither-get-ppt', 'leither-login', 'leither-ipfs-add', 'leither-port-detection'];
      labelsToClean.forEach(label => {
        if (timingLabels.has(label)) {
          console.timeEnd(`[${jobId}] ${label}`);
          timingLabels.delete(label);
        }
      });
      
      throw leitherError;
    }

  } catch (error) {
    console.error(`[${jobId}] [FATAL] An unexpected error occurred in /convert-video route:`, error);
    throw error;
  } finally {
    if (leitherClient) {
      global.releaseLeitherConnection(leitherClient);
    }
    
    if (uploadedFile && uploadedFile.tempFilePath && fs.existsSync(uploadedFile.tempFilePath)) {
      try {
        fs.unlinkSync(uploadedFile.tempFilePath);
        console.log(`[${jobId}] [CLEANUP] Removed temporary uploaded file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        console.error(`[${jobId}] [ERROR] Failed to cleanup uploaded file:`, cleanupError);
      }
    }
    
    console.log(`[${jobId}] [INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
    console.log(`[${jobId}] [INFO] HLS files preserved in: ${tempDir}`);
    console.log(`[${new Date().toISOString()}] [${jobId}] --- /convert-video route processing finished ---\n`);
  }
}

// Store for tracking video processing status
const processingJobs = new Map();

// Video conversion endpoint
router.post('/convert-video', async (req, res) => {
  const uploadStartTime = Date.now();
  console.log(`[UPLOAD-TIMING] Upload request received at ${new Date().toISOString()}`);
  
  // Set longer timeout for video processing
  req.setTimeout(6 * 60 * 60 * 1000); // 6 hours
  res.setTimeout(6 * 60 * 60 * 1000); // 6 hours
  
  // Handle connection close gracefully
  req.on('close', () => {
    console.log('[CONVERT-VIDEO] Client disconnected during upload');
  });
  
  req.on('error', (error) => {
    console.error('[CONVERT-VIDEO] Request error:', error);
  });
  
  res.on('close', () => {
    console.log('[CONVERT-VIDEO] Response closed');
  });
  
  // Generate a unique job ID
  const jobId = Math.random().toString(36).substr(2, 9);
  
  // Store job status
  processingJobs.set(jobId, {
    status: 'uploading',
    progress: 0,
    message: 'Starting upload...',
    startTime: Date.now()
  });
  
  try {
    const requestReceivedTime = Date.now();
    console.log(`[UPLOAD-TIMING] Request processing started at ${new Date().toISOString()} (${requestReceivedTime - uploadStartTime}ms after request received)`);
    
    // Debug: Log request details
    console.log(`[${jobId}] [DEBUG] Request method: ${req.method}`);
    console.log(`[${jobId}] [DEBUG] Request path: ${req.path}`);
    console.log(`[${jobId}] [DEBUG] Request headers:`, req.headers);
    console.log(`[${jobId}] [DEBUG] Request files:`, req.files ? Object.keys(req.files) : 'No files');
    console.log(`[${jobId}] [DEBUG] Request body keys:`, req.body ? Object.keys(req.body) : 'No body');
    
    // Validate upload BEFORE sending response
    if (!req.files || !req.files.videoFile) {
      console.error(`[${jobId}] [ERROR] No video file found in request. Expected a file with field name "videoFile".`);
      console.error(`[${jobId}] [ERROR] Available files:`, req.files ? Object.keys(req.files) : 'No files object');
      console.error(`[${jobId}] [ERROR] Request body:`, req.body);
      console.error(`[${jobId}] [ERROR] Request headers:`, req.headers);
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded. Please use the "videoFile" field name.'
      });
    }
    
    // Log file details for debugging
    const uploadedFile = req.files.videoFile;
    console.log(`[${jobId}] [UPLOAD-DEBUG] File received: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);
    console.log(`[${jobId}] [UPLOAD-DEBUG] File path: ${uploadedFile.tempFilePath}`);
    
    // Send immediate response with job ID
    const responseSentTime = Date.now();
    console.log(`[UPLOAD-TIMING] Sending response at ${new Date().toISOString()} (${responseSentTime - uploadStartTime}ms total upload time)`);
    
    res.json({
      success: true,
      message: 'Video upload started',
      jobId: jobId
    });
    
    console.log(`[UPLOAD-TIMING] Response sent successfully, starting background processing`);
    
    // Process video in background
    processVideoUploadAsync(req, jobId);
    
  } catch (error) {
    console.error(`[${jobId}] [ERROR] Failed to process video upload:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to process video upload: ' + error.message
    });
  }
});

// Async video processing function
async function processVideoUploadAsync(req, jobId) {
  console.log(`[${jobId}] Starting background video processing...`);
  
  try {
    // Update job status to processing
    processingJobs.set(jobId, {
      status: 'processing',
      progress: 20,
      message: 'Starting video processing...',
      startTime: processingJobs.get(jobId).startTime
    });
    
    console.log(`[${jobId}] Calling processVideoUploadInternal...`);
    
    // Process the video (reuse existing logic)
    const result = await processVideoUploadInternal(req, jobId);
    
    console.log(`[${jobId}] Video processing completed, CID:`, result.cid);
    
    // Update job status with success
    processingJobs.set(jobId, {
      status: 'completed',
      progress: 100,
      message: 'Video processing completed successfully',
      cid: result.cid,
      tempDir: result.tempDir,
      startTime: processingJobs.get(jobId).startTime,
      endTime: Date.now()
    });
    
  } catch (error) {
    console.error(`[${jobId}] Background processing failed:`, error);
    
    // Update job status with error
    processingJobs.set(jobId, {
      status: 'failed',
      progress: 0,
      message: error.message || 'Video processing failed',
      error: error.message,
      startTime: processingJobs.get(jobId).startTime,
      endTime: Date.now()
    });
  }
}

// Status check endpoint
router.get('/convert-video/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = processingJobs.get(jobId);
  
  console.log(`[${jobId}] Status check requested, current job:`, job ? {
    status: job.status,
    progress: job.progress,
    message: job.message
  } : 'Job not found');
  
  if (!job) {
    return res.status(404).json({
      success: false,
      message: 'Job not found'
    });
  }
  
  res.json({
    success: true,
    jobId: jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    cid: job.cid,
    tempDir: job.tempDir,
    startTime: job.startTime,
    endTime: job.endTime
  });
});

module.exports = router; 