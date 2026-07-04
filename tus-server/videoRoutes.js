const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
// Leither is now called directly via command line, not through API

// Promisify exec for async/await usage
const execAsync = promisify(exec);

// Concurrency management
let activeUploads = 0;
const maxConcurrentUploads = 3;
const uploadQueue = [];
let isProcessingQueue = false;

// Video quality constants:
// 720p => 2500k, scaled by reference resolution, with a 600k floor.
const MIN_BITRATE = 600;
const REFERENCE_720P_BITRATE = 2500;
const HLS_AUDIO_BITRATE = 128;
const HLS_AUDIO_BITRATE_BPS = HLS_AUDIO_BITRATE * 1000;
const HLS_CONVERSION_CUTOFF_MB = 50;

function calculateVideoBitrateK(referenceResolution) {
  const resolution = Math.max(1, Number(referenceResolution) || 0);
  const width = Math.round((resolution * 16) / 9);
  const pixelCount = width * resolution;
  const referencePixels = 1280 * 720;
  return Math.max(
    MIN_BITRATE,
    Math.round((pixelCount / referencePixels) * REFERENCE_720P_BITRATE)
  );
}

function capBitrateToSourceK(calculatedBitrateK, sourceBitrateK, logPrefix) {
  const calculated = Math.max(1, Number(calculatedBitrateK) || 0);
  const source = Number(sourceBitrateK);

  if (Number.isFinite(source) && source > 0 && source < calculated) {
    if (logPrefix) {
      console.log(`${logPrefix} [BITRATE] Keeping lower source bitrate ${source}k instead of calculated target ${calculated}k`);
    }
    return source;
  }

  return calculated;
}

// Track active temporary directories to prevent cleanup during processing
const activeTempDirs = new Set();

// Hardware encoder detection is now handled in app.js

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

function getMp4ToAnnexBFilterForCodec(codec) {
  const normalizedCodec = String(codec || '').toLowerCase();
  if (
    normalizedCodec.includes('hevc') ||
    normalizedCodec.includes('h265') ||
    normalizedCodec.includes('h.265')
  ) {
    return 'hevc_mp4toannexb';
  }
  return 'h264_mp4toannexb';
}

function getNormalizedVideoCodec(sourceCodec, finalEncoder) {
  const encoder = String(finalEncoder || '').toLowerCase();
  if (encoder === 'copy') {
    return sourceCodec;
  }
  if (encoder.includes('hevc') || encoder.includes('h265') || encoder.includes('h.265')) {
    return 'hevc';
  }
  return 'h264';
}

async function logMediaProbe(label, filePath, logPrefix) {
  try {
    const ffprobeCommand = `ffprobe -v error -print_format json -show_format -show_streams ${escapeShellArg(filePath)}`;
    const result = await execAsync(ffprobeCommand, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    const metadata = JSON.parse(result.stdout);
    const video = metadata.streams && metadata.streams.find(stream => stream.codec_type === 'video');
    const audio = metadata.streams && metadata.streams.find(stream => stream.codec_type === 'audio');
    const videoSummary = video
      ? `${video.codec_name || 'unknown'}/${video.profile || 'unknown'}/${video.pix_fmt || 'unknown'} ${video.width || '?'}x${video.height || '?'} bit_rate=${video.bit_rate || 'unknown'} r=${video.r_frame_rate || 'unknown'} avg=${video.avg_frame_rate || 'unknown'}`
      : 'none';
    const audioSummary = audio
      ? `${audio.codec_name || 'unknown'}/${audio.sample_rate || 'unknown'}Hz/${audio.channels || 'unknown'}ch bit_rate=${audio.bit_rate || 'unknown'}`
      : 'none';

    console.log(`${logPrefix} [PROBE] ${label}: video=${videoSummary} audio=${audioSummary} format_bitrate=${metadata.format && metadata.format.bit_rate ? metadata.format.bit_rate : 'unknown'} duration=${metadata.format && metadata.format.duration ? metadata.format.duration : 'unknown'}`);
  } catch (error) {
    console.warn(`${logPrefix} [PROBE] ${label}: failed to inspect media: ${error.message}`);
  }
}

// Helper function to update progress ensuring it never decreases across the entire process
function updateProgressSafe(jobId, newProgress, message) {
  const currentJob = processingJobs.get(jobId);
  const currentProgress = currentJob ? currentJob.progress : 0;
  // Always ensure progress only increases, never decreases
  const finalProgress = Math.max(currentProgress, Math.min(newProgress, 100));
  
  // Debug log to track progress changes
  if (finalProgress !== currentProgress) {
    console.log(`[${jobId}] [PROGRESS-SAFE] Updating: ${currentProgress}% → ${finalProgress}% (requested: ${newProgress}%) - ${message}`);
  }
  
  processingJobs.set(jobId, {
    ...(currentJob || {}),
    progress: finalProgress,
    message: message || (currentJob ? currentJob.message : 'Processing...')
  });
  
  return finalProgress;
}

// Helper function to execute commands with fallback for COPY preset failures
async function executeWithProgressWithFallback(command, fallbackCommand, jobId, startProgress, endProgress, message, useCopy = false, fileSize = 0, mediaDurationSec = 0) {
  try {
    return await executeWithProgress(command, jobId, startProgress, endProgress, message, fileSize, mediaDurationSec);
  } catch (error) {
    if (useCopy && error.message.includes('Command exited with code')) {
      console.log(`[${jobId}] [FALLBACK] COPY preset failed, retrying with normal encoding: ${error.message}`);
      return await executeWithProgress(fallbackCommand, jobId, startProgress, endProgress, `${message} (fallback)`, fileSize, mediaDurationSec);
    }
    throw error;
  }
}

// Helper function to execute long-running commands with progress updates
function executeWithProgress(command, jobId, startProgress, endProgress, message, fileSize = 0, mediaDurationSec = 0) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] [PROGRESS] Starting ${message} (${startProgress}% - ${endProgress}%)`);
    
    const startTime = Date.now();
    let lastComputedProgress = startProgress;
    
    // Helper to update progress ensuring it never decreases (uses global safe helper with stage bounds)
    const updateProgress = (newProgress, progressMessage) => {
      const boundedProgress = Math.min(newProgress, endProgress);
      const finalProgress = updateProgressSafe(jobId, boundedProgress, progressMessage || message);
      
      // Update lastComputedProgress for this operation to track upward movement within this stage
      if (finalProgress > lastComputedProgress) {
        lastComputedProgress = finalProgress;
      }
    };
    
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      
      // Fallback to a simple elapsed-time heuristic only if we didn't parse progress from ffmpeg yet
      const timeProgress = Math.min(elapsed / (5 * 60 * 1000), 1);
      const heuristicProgress = Math.floor(startProgress + (endProgress - startProgress) * timeProgress);
      const currentProgress = Math.max(lastComputedProgress, heuristicProgress);
      
      updateProgress(currentProgress, `${message} (${minutes}m ${seconds}s elapsed)`);
      
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
        const text = chunk.toString();
        stderrBuffer += text;
      }
      
      // Try to extract processed time from ffmpeg progress lines when media duration is known
      if (mediaDurationSec && mediaDurationSec > 0) {
        // Typical ffmpeg progress snippet contains time=HH:MM:SS.xx
        const match = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk.toString());
        if (match) {
          const hours = parseInt(match[1], 10) || 0;
          const minutes = parseInt(match[2], 10) || 0;
          const seconds = parseFloat(match[3]) || 0;
          const processedSeconds = hours * 3600 + minutes * 60 + seconds;
          if (processedSeconds >= 0) {
            const ratio = Math.max(0, Math.min(processedSeconds / mediaDurationSec, 1));
            const computed = Math.floor(startProgress + (endProgress - startProgress) * ratio);
            // Use updateProgress helper to ensure progress never decreases
            updateProgress(computed, `${message} (${Math.floor(ratio * 100)}% of media duration)`);
          }
        }
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
        // Ensure progress reaches at least the end of this stage
        updateProgress(endProgress, `${message} completed`);
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

// Helper function to get Leither binary path from environment
function getLeitherBinaryPath() {
  const leitherPath = process.env.LEITHER_PATH;
  if (!leitherPath) {
    throw new Error('LEITHER_PATH environment variable is not set. Please set it to the path of the Leither binary or directory containing it.');
  }
  
  let finalPath = leitherPath;
  
  // Check if the path exists
  if (!fs.existsSync(leitherPath)) {
    const dirPath = path.dirname(leitherPath);
    const baseName = path.basename(leitherPath);
    const normalizedBaseName = baseName.toLowerCase();
    
    // If path ends with 'leither' (case-insensitive), try uppercase 'Leither' version
    if (normalizedBaseName === 'leither' || normalizedBaseName.endsWith('leither')) {
      // Try uppercase version: replace with 'Leither' (always uppercase L)
      const uppercasePath = path.join(dirPath, 'Leither');
      
      if (fs.existsSync(uppercasePath)) {
        finalPath = uppercasePath;
        console.warn(`[WARNING] LEITHER_PATH '${leitherPath}' not found, but found '${uppercasePath}'. Using uppercase 'Leither' version.`);
      } else if (fs.existsSync(dirPath)) {
        // Check if parent directory exists and try appending 'Leither'
        const stats = fs.statSync(dirPath);
        if (stats.isDirectory()) {
          const appendedPath = path.join(dirPath, 'Leither');
          if (fs.existsSync(appendedPath)) {
            finalPath = appendedPath;
            console.warn(`[WARNING] LEITHER_PATH '${leitherPath}' not found, but found '${appendedPath}' in parent directory.`);
          } else {
            throw new Error(`Leither binary not found. Tried: ${uppercasePath}, ${appendedPath}. The binary must be named 'Leither' with uppercase L.`);
          }
        } else {
          throw new Error(`Leither path not found: ${leitherPath}. Also tried: ${uppercasePath}`);
        }
      } else {
        throw new Error(`Leither path not found: ${leitherPath}. Directory '${dirPath}' does not exist.`);
      }
    } else if (fs.existsSync(dirPath)) {
      // Path doesn't end with 'leither', but maybe parent directory exists - try appending 'Leither'
      const stats = fs.statSync(dirPath);
      if (stats.isDirectory()) {
        const appendedPath = path.join(dirPath, 'Leither');
        if (fs.existsSync(appendedPath)) {
          finalPath = appendedPath;
          console.warn(`[WARNING] LEITHER_PATH '${leitherPath}' not found, but found '${appendedPath}' in parent directory.`);
        } else {
          throw new Error(`Leither binary not found. Tried: ${appendedPath}. The binary must be named 'Leither' with uppercase L.`);
        }
      } else {
        throw new Error(`Leither path not found: ${leitherPath}`);
      }
    } else {
      throw new Error(`Leither path not found: ${leitherPath}. Directory '${dirPath}' does not exist.`);
    }
  } else {
    const stats = fs.statSync(leitherPath);
    if (stats.isDirectory()) {
      // If it's a directory, append 'Leither' (with uppercase L) to the path
      // Note: The binary is always named 'Leither' with uppercase L
      finalPath = path.join(leitherPath, 'Leither');
      if (!fs.existsSync(finalPath)) {
        throw new Error(`Leither binary not found at path: ${finalPath} (LEITHER_PATH points to a directory but 'Leither' binary not found inside - note: must be uppercase L)`);
      }
    }
  }
  
  // Verify it's a file and executable (if possible)
  const finalStats = fs.statSync(finalPath);
  if (!finalStats.isFile()) {
    throw new Error(`Leither path is not a file: ${finalPath}`);
  }
  
  // Verify the filename is 'Leither' with uppercase L
  const finalBaseName = path.basename(finalPath);
  if (finalBaseName.toLowerCase() === 'leither' && finalBaseName !== 'Leither') {
    throw new Error(`Leither binary name must be 'Leither' with uppercase L, but found '${finalBaseName}' at ${finalPath}`);
  }
  
  console.log(`[LEITHER-PATH] Resolved Leither binary path: ${finalPath} (basename: ${finalBaseName})`);
  
  return finalPath;
}

// Helper function to execute Leither command directly
async function executeLeitherCommand(command, requestId, timeoutMs = 6 * 60 * 60 * 1000) {
  const leitherPath = getLeitherBinaryPath();
  console.log(`[${requestId}] [LEITHER] Executing command with path: ${leitherPath}`);
  const fullCommand = `"${leitherPath}" ${command}`;
  console.log(`[${requestId}] [LEITHER] Full command: ${fullCommand}`);
  
  return new Promise((resolve, reject) => {
    let timeoutId;
    let isResolved = false;
    
    const child = exec(fullCommand, { 
      maxBuffer: 1024 * 1024 * 100, // 100MB buffer
      timeout: timeoutMs 
    }, (error, stdout, stderr) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (isResolved) return;
      isResolved = true;
      
      if (error) {
        console.error(`[${requestId}] [LEITHER] Command failed:`, error.message);
        if (stderr) {
          console.error(`[${requestId}] [LEITHER] stderr:`, stderr);
        }
        reject(error);
      } else {
        const output = stdout.trim();
        resolve(output);
      }
    });
    
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        child.kill('SIGKILL');
        reject(new Error(`Leither command timed out after ${Math.round(timeoutMs / (60 * 1000))} minutes`));
      }
    }, timeoutMs);
  });
}

// Helper function to execute Leither operations with progress updates
function executeLeitherOperationWithProgress(command, jobId, startProgress, endProgress, message, timeoutMs = 6 * 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] [LEITHER-PROGRESS] Starting ${message} (${startProgress}% - ${endProgress}%)`);
    
    const startTime = Date.now();
    let lastComputedProgress = startProgress;
    
    // Helper to update progress ensuring it never decreases (uses global safe helper with stage bounds)
    const updateProgress = (newProgress, progressMessage) => {
      const boundedProgress = Math.min(newProgress, endProgress);
      const finalProgress = updateProgressSafe(jobId, boundedProgress, progressMessage || message);
      
      if (finalProgress > lastComputedProgress) {
        lastComputedProgress = finalProgress;
      }
    };
    
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      
      // Update progress based on elapsed time (rough estimation)
      const timeProgress = Math.min(elapsed / (10 * 60 * 1000), 1); // Assume 10 minutes max for Leither operations
      const currentProgress = Math.floor(startProgress + (endProgress - startProgress) * timeProgress);
      const finalProgress = Math.max(lastComputedProgress, currentProgress);
      
      updateProgress(finalProgress, `${message} (${minutes}m ${seconds}s elapsed)`);
      
      console.log(`[${jobId}] [LEITHER-PROGRESS] ${message}: ${finalProgress}% (${minutes}m ${seconds}s elapsed)`);
    }, 10000); // Update every 10 seconds for Leither operations
    
    const leitherPath = getLeitherBinaryPath();
    console.log(`[${jobId}] [LEITHER] Executing command with path: ${leitherPath}`);
    const fullCommand = `"${leitherPath}" ${command}`;
    console.log(`[${jobId}] [LEITHER] Full command: ${fullCommand}`);
    let isResolved = false;
    let timeoutId;
    
    const child = exec(fullCommand, { 
      maxBuffer: 1024 * 1024 * 100, // 100MB buffer
      timeout: timeoutMs 
    }, (error, stdout, stderr) => {
      clearInterval(progressInterval);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (isResolved) return;
      isResolved = true;
      
      if (error) {
        console.error(`[${jobId}] [LEITHER-PROGRESS] ${message} failed:`, error.message);
        if (stderr) {
          console.error(`[${jobId}] [LEITHER-PROGRESS] stderr:`, stderr);
        }
        reject(error);
      } else {
        // Ensure progress reaches at least the end of this stage
        updateProgress(endProgress, `${message} completed`);
        console.log(`[${jobId}] [LEITHER-PROGRESS] ${message} completed successfully`);
        const output = stdout.trim();
        resolve(output);
      }
    });
    
    // Setup timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        clearInterval(progressInterval);
        child.kill('SIGKILL');
        reject(new Error(`${message} timeout after ${Math.round(timeoutMs / (60 * 1000))} minutes`));
      }
    }, timeoutMs);
  });
}

// Helper function to ensure dimensions are even (required for H.264)
function ensureEvenDimensions(width, height) {
  return {
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1
  };
}

function getPathSizeSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  const stats = fs.statSync(filePath);
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  return fs.readdirSync(filePath).reduce((total, child) => {
    return total + (getPathSizeSync(path.join(filePath, child)) || 0);
  }, 0);
}

// Helper function to get video resolution (p value)
function getVideoResolution(displayWidth, displayHeight) {
  // For landscape videos (width ≥ height): resolution = HEIGHT (e.g., 1280×720 = 720p)
  // For portrait videos (height > width): resolution = WIDTH (e.g., 720×1280 = 720p)
  const isPortrait = displayHeight > displayWidth;
  return isPortrait ? displayWidth : displayHeight;
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
            // Check if this directory is currently being used by an active upload
            const isInUse = activeTempDirs.has(filePath);
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

// Helper function to detect available hardware encoders (now uses global from app.js)
function detectHardwareEncoders() {
  console.log('[HARDWARE] Getting hardware encoders from app.js global cache');
  try {
    // Safely get hardware encoders with fallback
    const encoders = global.getAvailableHardwareEncoders ? global.getAvailableHardwareEncoders() : null;
    if (encoders && typeof encoders === 'object') {
      return Promise.resolve(encoders);
    }
    // Fallback: no hardware encoders available
    console.log('[HARDWARE] Hardware encoder detection unavailable, using software encoding fallback');
    return Promise.resolve({ nvidia: false, intel: false, apple: false, amd: false });
  } catch (error) {
    console.error('[HARDWARE] Error detecting hardware encoders:', error.message);
    console.log('[HARDWARE] Falling back to software encoding');
    return Promise.resolve({ nvidia: false, intel: false, apple: false, amd: false });
  }
}

// Helper function to get optimal encoder settings
async function getOptimalEncoder(availableEncoders, videoInfo = null, allowCopy = true) {
  // Safety check: ensure availableEncoders is a valid object
  if (!availableEncoders || typeof availableEncoders !== 'object') {
    console.warn('[HARDWARE] Invalid availableEncoders provided, defaulting to software encoding');
    availableEncoders = { nvidia: false, intel: false, apple: false, amd: false };
  }
  
  console.log('[HARDWARE] Getting optimal encoder for:', availableEncoders, 'allowCopy:', allowCopy);
  const is10Bit = videoInfo && videoInfo.bitDepth && videoInfo.bitDepth > 8;
  console.log('[HARDWARE] Video is 10-bit:', is10Bit);
  
  // Check if video resolution is no bigger than target resolution to use COPY preset
  let useCopyPreset = false;
  if (videoInfo && allowCopy) {  // Only check for COPY if allowed
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
    console.log('[HARDWARE] Using NVIDIA encoder (already tested at startup)');
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
  
  if (availableEncoders.intel) {
    console.log('[HARDWARE] Using Intel encoder (already tested at startup)');
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
  
  if (availableEncoders.apple) {
    console.log('[HARDWARE] Using Apple encoder (already tested at startup)');
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
  
  if (availableEncoders.amd) {
    console.log('[HARDWARE] Using AMD encoder (already tested at startup)');
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
  
  const bitrate720 = calculateVideoBitrateK(720);
  const bitrate480 = calculateVideoBitrateK(480);
  
  // Calculate optimal segment durations for each quality
  const segmentDuration720 = calculateOptimalSegmentDuration(videoInfo, bitrate720);
  const segmentDuration480 = calculateOptimalSegmentDuration(videoInfo, bitrate480);
  
  console.log(`[HLS-CONVERSION] Using bitrates - 720p: ${bitrate720}k, 480p: ${bitrate480}k (original: ${videoInfo && videoInfo.bitrate ? (videoInfo.bitrate / 1000).toFixed(0) + 'k' : 'unknown'})`);
  console.log(`[HLS-CONVERSION] Using segment durations - 720p: ${segmentDuration720}s, 480p: ${segmentDuration480}s`);

  // IMPORTANT: For multi-quality conversion, NEVER use copy encoder
  // Copy encoder cannot scale video, so both streams would be identical
  // This should never happen as getOptimalEncoder is called with allowCopy=false for multi-quality
  if (encoderConfig.useCopy || encoderConfig.encoder === 'copy') {
    console.error('[HLS-CONVERSION] ERROR: COPY encoder received for multi-quality conversion - this should not happen!');
    console.log('[HLS-CONVERSION] Force-using libx264 for multi-quality conversion since COPY cannot scale');
    encoderConfig = {
      ...encoderConfig,
      useCopy: false,
      encoder: 'libx264',
      hardware: false,
      preset: 'fast'
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
  
  // Get frame rate for GOP size calculation (default to 30fps if not available)
  const frameRate = videoInfo && videoInfo.frameRate ? videoInfo.frameRate : 30;
  
  // Calculate keyframe parameters for smooth HLS playback
  const keyframeParams720 = getHLSKeyframeParams(segmentDuration720, frameRate);
  const keyframeParams480 = getHLSKeyframeParams(segmentDuration480, frameRate);

  // Use simplified commands based on Android implementation
  console.log('[HLS-CONVERSION] Using simplified commands based on Android implementation');
  cmd720p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder}${formattedHwParams} -c:a aac -vf "scale=${dim720.width}:${dim720.height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams720} -b:v ${bitrate720}k -b:a ${HLS_AUDIO_BITRATE}k${formattedSoftwareParams} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration720} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
  cmd480p = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${encoderConfig.encoder}${formattedHwParams} -c:a aac -vf "scale=${dim480.width}:${dim480.height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams480} -b:v ${bitrate480}k -b:a ${HLS_AUDIO_BITRATE}k${formattedSoftwareParams} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration480} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '480p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '480p/playlist.m3u8'))}`;

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
  } else if (bitrate < MIN_BITRATE) {
    segmentDuration = Math.max(segmentDuration - 2, 4); // Cap at 4 seconds
  }
  
  console.log(`[HLS-SEGMENTS] Resolution: ${width}x${height}, Bitrate: ${bitrate}k, Segment duration: ${segmentDuration}s`);
  return segmentDuration;
}

// Helper function to calculate GOP size and keyframe parameters for HLS
// Ensures keyframes align with segment boundaries for smooth playback
function getHLSKeyframeParams(segmentDuration, frameRate = 30) {
  // Calculate GOP size: segment duration in frames
  // Round to nearest integer and ensure it's reasonable (between 30 and 600 frames)
  const gopSize = Math.max(30, Math.min(600, Math.round(segmentDuration * frameRate)));
  
  // For HLS, keyframes must align with segment boundaries
  // Use keyint_min equal to GOP size to ensure consistent keyframe interval
  // sc_threshold=0 disables scene change detection to prevent unexpected keyframes
  return `-g ${gopSize} -keyint_min ${gopSize} -sc_threshold 0`;
}

function getRotationFilter(rotation) {
  return rotation === 90 ? 'transpose=1'
       : rotation === -90 || rotation === 270 ? 'transpose=2'
       : rotation === 180 ? 'transpose=2,transpose=2'
       : '';
}

function extractCidFromLeitherOutput(output) {
  const trimmedOutput = String(output || '').trim();
  const ipfsAddOkMatch = trimmedOutput.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
  if (ipfsAddOkMatch) {
    return ipfsAddOkMatch[1];
  }

  const cidMatch = trimmedOutput.match(/(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/);
  return cidMatch ? cidMatch[1] : null;
}

function cleanupPartialHLSOutput(tempDir) {
  for (const entry of ['720p', '480p', 'master.m3u8', 'playlist.m3u8']) {
    const entryPath = path.join(tempDir, entry);
    if (fs.existsSync(entryPath)) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }

  for (const file of fs.readdirSync(tempDir)) {
    if (/^segment\d+\.ts$/.test(file)) {
      fs.rmSync(path.join(tempDir, file), { force: true });
    }
  }
}

function createSinglePassDualHLSCommand({
  inputPath,
  tempDir,
  videoInfo,
  highQualityWidth,
  highQualityHeight,
  highQualityBitrate,
  variant480Width,
  variant480Height,
  variant480Bitrate,
  segmentDuration,
  frameRate,
  hasAudio
}) {
  fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });

  const rotationFilter = getRotationFilter(videoInfo.rotation || 0);
  const baseFilters = rotationFilter
    ? `[0:v]${rotationFilter},split=2[v720in][v480in]`
    : '[0:v]split=2[v720in][v480in]';
  const filterComplex = [
    baseFilters,
    `[v720in]scale=${highQualityWidth}:${highQualityHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[v720]`,
    `[v480in]scale=${variant480Width}:${variant480Height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[v480]`
  ].join(';');

  const gopSize = Math.max(30, Math.min(600, Math.round(segmentDuration * frameRate)));
  const audioMap = hasAudio ? `-map ${escapeShellArg('0:a:0?')}` : '';
  const audioEncoding = hasAudio ? ` -c:a aac -b:a ${HLS_AUDIO_BITRATE}k` : '';
  const streamMap = hasAudio
    ? 'v:0,a:0,name:720p v:1,a:1,name:480p'
    : 'v:0,name:720p v:1,name:480p';

  return [
    'ffmpeg',
    '-y',
    '-fflags +genpts+igndts',
    `-i ${escapeShellArg(inputPath)}`,
    `-filter_complex ${escapeShellArg(filterComplex)}`,
    '-map "[v720]"',
    audioMap,
    '-map "[v480]"',
    audioMap,
    '-c:v libx264',
    '-profile:v main',
    '-level 4.1',
    '-pix_fmt yuv420p',
    '-preset fast',
    '-tune zerolatency',
    '-threads 2',
    `-b:v:0 ${highQualityBitrate}k`,
    `-b:v:1 ${variant480Bitrate}k`,
    `-g ${gopSize}`,
    `-keyint_min ${gopSize}`,
    '-sc_threshold 0',
    `-force_key_frames ${escapeShellArg(`expr:gte(t,n_forced*${segmentDuration})`)}`,
    audioEncoding,
    '-avoid_negative_ts make_zero',
    '-max_muxing_queue_size 1024',
    '-f hls',
    `-hls_time ${segmentDuration}`,
    '-hls_list_size 0',
    '-hls_playlist_type vod',
    '-hls_segment_type mpegts',
    '-start_number 0',
    '-master_pl_name master.m3u8',
    `-hls_segment_filename ${escapeShellArg(path.join(tempDir, '%v/segment%03d.ts'))}`,
    `-var_stream_map ${escapeShellArg(streamMap)}`,
    escapeShellArg(path.join(tempDir, '%v/playlist.m3u8'))
  ].filter(Boolean).join(' ');
}

// Helper function to get hardware-specific encoding parameters (now uses global from app.js)
function getHardwareEncodingParams(encoder, is10Bit = false) {
  try {
    if (global.getHardwareEncodingParams && typeof global.getHardwareEncodingParams === 'function') {
      return global.getHardwareEncodingParams(encoder, is10Bit);
    }
    console.warn('[HARDWARE] getHardwareEncodingParams not available, returning empty params');
    return '';
  } catch (error) {
    console.error('[HARDWARE] Error getting hardware encoding params:', error.message);
    return '';
  }
}

// Main video processing function
async function processVideoUpload(req, res) {
  const routeStartTime = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  console.log(`\n[${new Date().toISOString()}] [${requestId}] --- /convert-video route processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;
  
  // Set proper headers to keep connection alive
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=21600, max=1000'); // 6 hours timeout

  try {
    // Cleanup old temporary files (will skip any in activeTempDirs)
    console.log(`[${requestId}] [CLEANUP] Cleaning up old temporary files...`);
    cleanupOldTempFiles();

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
    
    // Register this temp directory to prevent cleanup
    activeTempDirs.add(tempDir);

    // Get video dimensions (always needed for routing and normalization decisions)
    let videoInfo = null;

    console.log(`\n[${requestId}] [STEP 3] Getting video dimensions${noResample ? ' (noResample=true, will preserve original)' : ''}...`);
    const getVideoInfoSync = () => {
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
                
                // Extract frame rate
                let frameRate = 30; // Default to 30fps if not available
                if (videoStream.r_frame_rate) {
                  const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
                  if (den && den > 0) {
                    frameRate = num / den;
                  }
                } else if (videoStream.avg_frame_rate) {
                  const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
                  if (den && den > 0) {
                    frameRate = num / den;
                  }
                }
                
                console.log(`[${requestId}] [INFO] Original video bitrate: ${originalBitrate ? (originalBitrate / 1000).toFixed(0) + 'k' : 'unknown'}`);
                console.log(`[${requestId}] [INFO] Video frame rate: ${frameRate.toFixed(2)} fps`);
                
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
                  bitrate: originalBitrate,
                  frameRate: frameRate
                });
              } catch (parseError) {
                console.error(`[${requestId}] [ERROR] Failed to parse ffprobe JSON:`, parseError);
                reject(new Error(`Failed to parse video metadata: ${parseError.message}`));
              }
            })
            .catch(reject);
        });
    };

    videoInfo = await getVideoInfoSync();
    console.log(`[${requestId}] [INFO] Video dimensions: ${videoInfo.width}x${videoInfo.height}, duration: ${videoInfo.duration}s`);
    console.log(`[${requestId}] [INFO] Display orientation: ${(videoInfo.displayHeight || videoInfo.height) > (videoInfo.displayWidth || videoInfo.width) ? 'Portrait' : 'Landscape'} (${videoInfo.displayWidth || videoInfo.width}x${videoInfo.displayHeight || videoInfo.height})`);
    if (videoInfo.rotation !== 0) {
      console.log(`[${requestId}] [INFO] Video has rotation: ${videoInfo.rotation}°`);
    }

    // Normalize video to MP4 format
    console.log(`\n[${requestId}] [STEP 4] Normalizing video...`);
    console.time(`[${requestId}] video-normalization`);
    
    const displayWidth = videoInfo ? (videoInfo.displayWidth || videoInfo.width) : null;
    const displayHeight = videoInfo ? (videoInfo.displayHeight || videoInfo.height) : null;
    
    if (!displayWidth || !displayHeight) {
      throw new Error('Cannot determine video dimensions for normalization');
    }
    
    const videoResolution = getVideoResolution(displayWidth, displayHeight);
    console.log(`[${requestId}] [INFO] Video resolution: ${videoResolution}p`);
    
    // Get source video bitrate (in bps, convert to kbps)
    const sourceBitrateK = videoInfo && videoInfo.bitrate ? Math.floor(videoInfo.bitrate / 1000) : null;
    
    // Determine normalization parameters based on resolution
    let targetWidth, targetHeight, calculatedBitrateK;

    if (noResample) {
      // Preserve Quality: cap at 1080p, keep original if already ≤1080p
      if (videoResolution > 1080) {
        console.log(`[${requestId}] [NORMALIZE] noResample=true, video (${videoResolution}p) > 1080p, normalizing to 1080p`);
        const isPortrait = displayHeight > displayWidth;
        if (isPortrait) {
          targetWidth = 1080;
          targetHeight = Math.round((1080 * displayHeight) / displayWidth);
        } else {
          targetHeight = 1080;
          targetWidth = Math.round((1080 * displayWidth) / displayHeight);
        }
        const evenDims = ensureEvenDimensions(targetWidth, targetHeight);
        targetWidth = evenDims.width;
        targetHeight = evenDims.height;
        calculatedBitrateK = calculateVideoBitrateK(1080);
      } else {
        console.log(`[${requestId}] [NORMALIZE] noResample=true, video (${videoResolution}p) ≤ 1080p, keeping original resolution`);
        const evenDims = ensureEvenDimensions(displayWidth, displayHeight);
        targetWidth = evenDims.width;
        targetHeight = evenDims.height;
        calculatedBitrateK = calculateVideoBitrateK(videoResolution);
      }
    } else if (videoResolution > 720) {
      // >720p: normalize to 720p with shared bitrate
      console.log(`[${requestId}] [NORMALIZE] Video resolution (${videoResolution}p) > 720p, normalizing to 720p with shared bitrate`);
      const isPortrait = displayHeight > displayWidth;
      if (isPortrait) {
        targetWidth = 720;
        targetHeight = Math.round((720 * displayHeight) / displayWidth);
      } else {
        targetHeight = 720;
        targetWidth = Math.round((720 * displayWidth) / displayHeight);
      }
      const evenDims = ensureEvenDimensions(targetWidth, targetHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      calculatedBitrateK = calculateVideoBitrateK(720);
    } else if (videoResolution === 720) {
      // =720p: keep resolution, use shared bitrate
      console.log(`[${requestId}] [NORMALIZE] Video resolution is 720p, keeping resolution with shared bitrate`);
      const evenDims = ensureEvenDimensions(displayWidth, displayHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      calculatedBitrateK = calculateVideoBitrateK(720);
    } else {
      // <720p: keep resolution, use shared bitrate
      console.log(`[${requestId}] [NORMALIZE] Video resolution (${videoResolution}p) < 720p, keeping resolution with shared bitrate`);
      const evenDims = ensureEvenDimensions(displayWidth, displayHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      calculatedBitrateK = calculateVideoBitrateK(videoResolution);
    }
    
    const bitrate = capBitrateToSourceK(calculatedBitrateK, sourceBitrateK, `[${requestId}]`);
    
    console.log(`[${requestId}] [INFO] Normalization target: ${targetWidth}x${targetHeight}, source bitrate: ${sourceBitrateK}k, calculated target: ${calculatedBitrateK}k, final bitrate: ${bitrate}k`);
    
    // Check if scaling is needed (target dimensions differ from original)
    const needsScaling = targetWidth !== displayWidth || targetHeight !== displayHeight;

    // Build transpose filter to physically bake in rotation when the source has
    // a rotation flag. Without this, copy-mode remuxing strips the flag and
    // the output plays sideways; even re-encode paths lose it in HLS segments.
    const rotation = videoInfo ? (videoInfo.rotation || 0) : 0;
    const transposeFilter = rotation === 90 ? 'transpose=1'
                          : rotation === -90 || rotation === 270 ? 'transpose=2'
                          : rotation === 180 ? 'transpose=2,transpose=2'
                          : '';
    const needsRotation = transposeFilter !== '';

    // Get encoder config - force re-encoding if scaling or rotation is needed
    const availableEncoders = await detectHardwareEncoders();
    const encoderConfig = await getOptimalEncoder(availableEncoders, videoInfo, !needsScaling && !needsRotation);

    // If copy encoder was selected but we need scaling or rotation, force re-encoding
    let finalEncoder = encoderConfig.encoder;
    if ((encoderConfig.useCopy || encoderConfig.encoder === 'copy') && (needsScaling || needsRotation)) {
      console.log(`[${requestId}] [NORMALIZE] Filter needed (scaling=${needsScaling}, rotation=${needsRotation}) but copy encoder selected, forcing re-encoding with libx264`);
      finalEncoder = 'libx264';
      encoderConfig.hardware = false;
      encoderConfig.preset = 'fast';
    }

    const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(finalEncoder, encoderConfig.is10Bit) : '';
    const softwareParams = encoderConfig.hardware ? '' : '-preset fast -tune zerolatency -threads 2';

    // Build combined video filter: rotation (transpose) first, then scale
    let vfFilter = '';
    if (needsRotation && needsScaling) {
      vfFilter = `-vf "${transposeFilter},scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2"`;
    } else if (needsRotation) {
      vfFilter = `-vf "${transposeFilter}"`;
    } else if (needsScaling) {
      vfFilter = `-vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2"`;
    }
    if (needsRotation) {
      console.log(`[${requestId}] [NORMALIZE] Applying rotation correction: ${transposeFilter} (source rotation=${rotation}°)`);
    }

    // Normalize to MP4
    const normalizedFilePath = path.join(tempDir, 'normalized.mp4');
    const isCopyNormalize = finalEncoder === 'copy';
    const ffmpegCmd = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v ${finalEncoder}${hwParams ? ` ${hwParams}` : ''} -c:a aac -b:v ${bitrate}k -b:a ${HLS_AUDIO_BITRATE}k${vfFilter ? ` ${vfFilter}` : ''} -movflags +faststart ${escapeShellArg(normalizedFilePath)} -y${softwareParams ? ` ${softwareParams}` : ''}`;

    console.log(`[${requestId}] [SERVER-UPLOAD] Normalization decision: encoder=${finalEncoder}, copy=${isCopyNormalize}, needsScaling=${needsScaling}, needsRotation=${needsRotation}, hwParams="${hwParams || 'none'}", softwareParams="${softwareParams || 'none'}", vf="${vfFilter || 'none'}"`);
    console.log(`[${requestId}] [FFMPEG] Normalize command: ${ffmpegCmd}`);
    console.log(`[${requestId}] [FFMPEG] Running normalization command...`);
    await executeWithProgress(ffmpegCmd, requestId, 0, 50, 'Normalizing video...', uploadedFile.size, videoInfo && videoInfo.duration ? videoInfo.duration : 0);
    await logMediaProbe('normalized.mp4', normalizedFilePath, `[${requestId}]`);
    
    const normalizedFileSize = fs.statSync(normalizedFilePath).size;
    const normalizedFileSizeMB = normalizedFileSize / (1024 * 1024);
    const normalizedVideoCodec = getNormalizedVideoCodec(videoInfo ? videoInfo.codec : null, finalEncoder);
    const copyBitstreamFilter = getMp4ToAnnexBFilterForCodec(normalizedVideoCodec);
    console.log(`[${requestId}] [INFO] Normalized file size: ${normalizedFileSizeMB.toFixed(2)}MB`);
    console.log(`[${requestId}] [SERVER-UPLOAD] Normalized codec for HLS copy=${normalizedVideoCodec || 'unknown'}, bitstreamFilter=${copyBitstreamFilter}`);
    
    console.timeEnd(`[${requestId}] video-normalization`);
    
    // Check file size and route accordingly
    let cid;
    
    if (normalizedFileSizeMB <= HLS_CONVERSION_CUTOFF_MB) {
      // File size <= cutoff: upload as MP4 directly to IPFS
      console.log(`[${requestId}] [ROUTE] Normalized file size (${normalizedFileSizeMB.toFixed(2)}MB) <= ${HLS_CONVERSION_CUTOFF_MB}MB, uploading as MP4 directly`);
      
      const escapedPath = escapeShellArg(normalizedFilePath);
      const cidOutput = await executeLeitherCommand(`ipfs add ${escapedPath}`, requestId, 600000); // 10 minutes timeout
      
      // Extract CID from output
      const trimmedOutput = cidOutput.trim();
      const ipfsAddOkMatch = trimmedOutput.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
      if (ipfsAddOkMatch) {
        cid = ipfsAddOkMatch[1];
      } else {
        const cidMatch = trimmedOutput.match(/(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/);
        if (cidMatch) {
          cid = cidMatch[1];
        }
      }
      
      if (!cid) {
        throw new Error('Failed to extract CID from IPFS add output');
      }
      
      console.log(`[${requestId}] [SUCCESS] MP4 video uploaded to IPFS, CID: ${cid}`);
    } else {
      // File size > cutoff: convert to HLS with 720p and 480p variants
      console.log(`[${requestId}] [ROUTE] Normalized file size (${normalizedFileSizeMB.toFixed(2)}MB) > ${HLS_CONVERSION_CUTOFF_MB}MB, converting to HLS`);

      // Get normalized resolution (after normalization, max resolution is 720p)
      const normalizedResolution = getVideoResolution(targetWidth, targetHeight);
      console.log(`[${requestId}] [HLS] Normalized resolution: ${normalizedResolution}p (${targetWidth}x${targetHeight})`);

      // HLS conversion: single variant for 480p videos, dual variant for others (like iOS)
      // - Resolution =480p: Single 480p variant (like iOS singleVariant480p=true)
      // - Resolution >720p: High quality 720p + 480p using shared bitrate
      // - Resolution =720p: High quality 720p + 480p using shared bitrate
      // - Resolution <720p & !=480p: High quality at original resolution + 480p using shared bitrate

      // Determine if portrait or landscape
      const isPortrait = targetHeight > targetWidth;
      const referenceDim = isPortrait ? targetWidth : targetHeight;

      // Check if this video should use single variant mode
      // noResample videos: single variant at original resolution (preserve quality)
      // 480p videos: single variant (like iOS singleVariant480p=true)
      // Videos with resolution <= 480p that would create identical variants: single variant (optimization)
      const is480pVideo = referenceDim === 480;
      const wouldCreateIdenticalVariants = referenceDim <= 480 && !is480pVideo; // 360p, 240p, etc. create identical variants

      let variantCount, variantType;
      if (noResample) {
        variantCount = 1;
        variantType = `single (${referenceDim}p original quality)`;
        console.log(`[${requestId}] [HLS] noResample=true - using single variant mode at original resolution ${targetWidth}x${targetHeight}`);
      } else if (is480pVideo || wouldCreateIdenticalVariants) {
        variantCount = 1;
        variantType = `single (${referenceDim}p only)`;
        const reason = is480pVideo ? 'like iOS' : 'identical variants optimization';
        console.log(`[${requestId}] [HLS] ${referenceDim}p video detected - using single variant mode (${reason})`);
      } else {
        variantCount = 2;
        variantType = 'dual (720p + 480p)';
        console.log(`[${requestId}] [HLS] Creating dual-variant HLS - Original resolution: ${normalizedResolution}p (${targetWidth}x${targetHeight})`);
      }

      // Determine high-quality variant dimensions and bitrate (only if not single variant)
      let highQualityWidth, highQualityHeight, highQualityBitrate;
      let variant480Width, variant480Height, variant480Bitrate;

      if (!(is480pVideo || wouldCreateIdenticalVariants)) {
        // High-quality variant (720p or original resolution)
        if (referenceDim > 720) {
          // Resolution >720p: normalize to 720p @ shared bitrate
          console.log(`[${requestId}] [HLS] Video resolution >720p, high quality: 720p @ shared bitrate`);
          if (isPortrait) {
            highQualityWidth = 720;
            highQualityHeight = Math.round((720 * targetHeight) / targetWidth);
          } else {
            highQualityHeight = 720;
            highQualityWidth = Math.round((720 * targetWidth) / targetHeight);
          }
          highQualityBitrate = calculateVideoBitrateK(720);
        } else if (referenceDim === 720) {
          // Resolution =720p: keep at 720p using shared bitrate
          console.log(`[${requestId}] [HLS] Video resolution =720p, high quality: 720p @ ${calculateVideoBitrateK(720)}k`);
          highQualityWidth = targetWidth;
          highQualityHeight = targetHeight;
          highQualityBitrate = calculateVideoBitrateK(720);
        } else {
          // Resolution <720p: keep original resolution with shared bitrate
          console.log(`[${requestId}] [HLS] Video resolution <720p, high quality: original @ shared bitrate`);
          highQualityWidth = targetWidth;
          highQualityHeight = targetHeight;

          highQualityBitrate = calculateVideoBitrateK(referenceDim);
        }

        // Ensure even dimensions for high quality
        const highQualityEvenDims = ensureEvenDimensions(highQualityWidth, highQualityHeight);
        highQualityWidth = highQualityEvenDims.width;
        highQualityHeight = highQualityEvenDims.height;
      }

      // Always create 480p variant (or single 480p variant for 480p videos)
      const target480Dim = Math.min(referenceDim, 480); // Don't upscale

      if (isPortrait) {
        variant480Width = target480Dim;
        variant480Height = Math.round((target480Dim * targetHeight) / targetWidth);
      } else {
        variant480Height = target480Dim;
        variant480Width = Math.round((target480Dim * targetWidth) / targetHeight);
      }

      // Ensure even dimensions for 480p
      const variant480EvenDims = ensureEvenDimensions(variant480Width, variant480Height);
      variant480Width = variant480EvenDims.width;
      variant480Height = variant480EvenDims.height;

      // 480p bitrate follows the shared preserve-quality curve
      variant480Bitrate = calculateVideoBitrateK(target480Dim);

      if (highQualityBitrate) {
        highQualityBitrate = capBitrateToSourceK(highQualityBitrate, bitrate, `[${requestId}] [HLS]`);
      }
      variant480Bitrate = capBitrateToSourceK(variant480Bitrate, bitrate, `[${requestId}] [HLS]`);

      if (!(is480pVideo || wouldCreateIdenticalVariants)) {
        console.log(`[${requestId}] [HLS] High quality variant: ${highQualityWidth}x${highQualityHeight} @ ${highQualityBitrate}k`);
      }
      console.log(`[${requestId}] [HLS] 480p variant: ${variant480Width}x${variant480Height} @ ${variant480Bitrate}k (shared bitrate curve, ${target480Dim}p reference)`);

      // For noResample single variant, use original dimensions instead of 480p
      const singleVariantWidth = noResample ? targetWidth : variant480Width;
      const singleVariantHeight = noResample ? targetHeight : variant480Height;
      const singleVariantBitrate = noResample ? bitrate : variant480Bitrate;

      // Get encoder config (use variant dimensions for single variant videos, high quality for dual variant)
      const isSingleVariant = noResample || is480pVideo || wouldCreateIdenticalVariants;

      // Create directories based on variant mode
      if (isSingleVariant) {
        // Single variant: no subdirectories needed, playlist and segments go to root
        // Directory already created by caller
      } else {
        // Dual variant: create subdirectories for both variants
        fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });
      }

      // Check if we can use COPY encoder for HLS conversion
      // Matches iOS logic: COPY is used based on resolution ranges, not exact dimensions
      // - 720p variant: use COPY if normalized resolution is between 480p and 720p (avoids upscaling)
      // - 480p variant: use COPY if normalized resolution is ≤480p (avoids upscaling)
      // This allows e.g. 576p content to use COPY for 720p variant (labeled as 720p but actual content is 576p)
      
      // Get normalized video resolution (reference dimension) - use the same logic as earlier
      const normalizedIsPortrait = targetHeight > targetWidth;
      const normalizedReferenceDim = normalizedIsPortrait ? targetWidth : targetHeight;
      
      const canUseCopySingle = isSingleVariant && (noResample || normalizedReferenceDim <= 480);
      const canUseCopyDual720 = !isSingleVariant && (normalizedReferenceDim > 480 && normalizedReferenceDim <= 720);

      console.log(`[${requestId}] [HLS] Normalized video: ${targetWidth}x${targetHeight} (${normalizedReferenceDim}p)`);
      if (isSingleVariant) {
        console.log(`[${requestId}] [HLS] Single variant target: ${singleVariantWidth}x${singleVariantHeight}, can use COPY: ${canUseCopySingle} (${noResample ? 'noResample' : 'normalized ≤480p'})`);
      } else {
        console.log(`[${requestId}] [HLS] Dual variant 720p target: ${highQualityWidth}x${highQualityHeight}, can use COPY: ${canUseCopyDual720} (normalized >480p and ≤720p)`);
        console.log(`[${requestId}] [HLS] Dual variant 480p target: ${variant480Width}x${variant480Height}, needs scaling`);
      }

      // Use hardware encoder if available for better performance (server advantage over iOS)
      const availableEncoders = await detectHardwareEncoders();
      let encoderConfig = await getOptimalEncoder(availableEncoders, {
        width: isSingleVariant ? singleVariantWidth : highQualityWidth,
        height: isSingleVariant ? singleVariantHeight : highQualityHeight,
        displayWidth: isSingleVariant ? singleVariantWidth : highQualityWidth,
        displayHeight: isSingleVariant ? singleVariantHeight : highQualityHeight
      }, false);

      // Safety check: ensure encoderConfig is valid
      if (!encoderConfig || !encoderConfig.encoder || typeof encoderConfig.encoder !== 'string') {
        console.warn(`[${requestId}] [HARDWARE] Invalid encoder config, falling back to libx264`);
        encoderConfig = { encoder: 'libx264', preset: 'fast', hardware: false, is10Bit: false };
      }

      const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder, encoderConfig.is10Bit) : '';
      const softwareParams = encoderConfig.hardware ? '' : `-preset ${encoderConfig.preset || 'fast'} -tune zerolatency -threads 2`;

      // Calculate segment durations
      const segmentDurationSingle = calculateOptimalSegmentDuration({
        displayWidth: singleVariantWidth,
        displayHeight: singleVariantHeight,
        duration: videoInfo ? videoInfo.duration : null
      }, singleVariantBitrate);

      // Get frame rate for GOP size calculation (default to 30fps if not available)
      const frameRate = videoInfo && videoInfo.frameRate ? videoInfo.frameRate : 30;

      // Calculate keyframe parameters for smooth HLS playback
      const keyframeParamsSingle = getHLSKeyframeParams(segmentDurationSingle, frameRate);

      let commands = [];
      let masterPlaylist = '';

      if (isSingleVariant) {
        // Single variant: playlist and segments at root level (simplified HLS structure)
        let cmd;
        if (canUseCopySingle) {
          // Use COPY encoder - no scaling, no re-encoding
          console.log(`[${requestId}] [HLS] Using COPY encoder for single variant (no scaling needed)`);
          cmd = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v copy -c:a aac -b:a ${HLS_AUDIO_BITRATE}k -fflags +genpts+igndts -bsf:v ${copyBitstreamFilter} -avoid_negative_ts make_zero -f hls -hls_time ${segmentDurationSingle} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
        } else {
          // Use libx264 encoder with scaling
          console.log(`[${requestId}] [HLS] Using libx264 encoder for single variant (scaling needed)`);
          cmd = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${singleVariantWidth}:${singleVariantHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParamsSingle} -b:v ${singleVariantBitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDurationSingle} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
        }

        commands = [
          { cmd: cmd, variant: `${referenceDim}p`, progressStart: 50, progressEnd: 80 }
        ];

        masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${singleVariantBitrate * 1000 + HLS_AUDIO_BITRATE_BPS},RESOLUTION=${singleVariantWidth}x${singleVariantHeight}
playlist.m3u8`;

        console.log(`[${requestId}] [HLS] Executing single-variant HLS conversion for ${referenceDim}p video...`);
      } else {
        // Dual variant: 720p + 480p
        const segmentDuration720 = calculateOptimalSegmentDuration({
          displayWidth: highQualityWidth,
          displayHeight: highQualityHeight,
          duration: videoInfo ? videoInfo.duration : null
        }, highQualityBitrate);

        // Calculate keyframe parameters for both variants
        const keyframeParams720 = getHLSKeyframeParams(segmentDuration720, frameRate);
        const segmentDuration480 = calculateOptimalSegmentDuration({
          displayWidth: variant480Width,
          displayHeight: variant480Height,
          duration: videoInfo ? videoInfo.duration : null
        }, variant480Bitrate);
        const keyframeParams480 = getHLSKeyframeParams(segmentDuration480, frameRate);

        // 720p variant: use COPY if dimensions match, otherwise libx264
        let cmd720p;
        if (canUseCopyDual720) {
          console.log(`[${requestId}] [HLS] Using COPY encoder for 720p variant (no scaling needed)`);
          cmd720p = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v copy -c:a aac -b:a ${HLS_AUDIO_BITRATE}k -fflags +genpts+igndts -bsf:v ${copyBitstreamFilter} -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration720} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
        } else {
          console.log(`[${requestId}] [HLS] Using libx264 encoder for 720p variant (scaling needed)`);
          cmd720p = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${highQualityWidth}:${highQualityHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams720} -b:v ${highQualityBitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration720} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
        }

        // 480p variant: always use libx264 (always needs scaling)
        console.log(`[${requestId}] [HLS] Using libx264 encoder for 480p variant (scaling needed)`);
        const cmd480p = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${variant480Width}:${variant480Height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams480} -b:v ${variant480Bitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration480} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '480p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '480p/playlist.m3u8'))}`;

        commands = [
          { cmd: cmd720p, variant: '720p', progressStart: 50, progressEnd: 65 },
          { cmd: cmd480p, variant: '480p', progressStart: 65, progressEnd: 80 }
        ];

        // Create master playlist for dual variant
        const bandwidth720 = highQualityBitrate * 1000 + HLS_AUDIO_BITRATE_BPS; // video + audio
        const bandwidth480 = variant480Bitrate * 1000 + HLS_AUDIO_BITRATE_BPS;

        masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth720},RESOLUTION=${highQualityWidth}x${highQualityHeight}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth480},RESOLUTION=${variant480Width}x${variant480Height}
480p/playlist.m3u8`;

        console.log(`[${requestId}] [HLS] Executing dual-variant HLS conversion...`);
      }

      // Execute HLS conversion commands
      commands.forEach(command => {
        console.log(`[${requestId}] [FFMPEG] HLS command (${command.variant}): ${command.cmd}`);
      });
      await Promise.all(commands.map((command, index) =>
        executeWithProgress(
          command.cmd,
          requestId,
          command.progressStart,
          command.progressEnd,
          `Converting to ${command.variant} HLS...`,
          normalizedFileSize,
          videoInfo && videoInfo.duration ? videoInfo.duration : 0
        )
      ));

      // Delete normalized.mp4 file after HLS conversion (cleanup)
      console.log(`[${requestId}] [CLEANUP] Deleting normalized.mp4 from HLS directory...`);
      try {
        if (fs.existsSync(normalizedFilePath)) {
          fs.unlinkSync(normalizedFilePath);
          console.log(`[${requestId}] [CLEANUP] Successfully deleted normalized.mp4`);
        }
      } catch (cleanupError) {
        console.warn(`[${requestId}] [CLEANUP] Failed to delete normalized.mp4:`, cleanupError.message);
      }

      // Create master playlist file for all HLS conversions (needed for web browser compatibility)
      // Even single variants need master.m3u8 because web players try to load it first
      // iOS AVPlayer can handle both with and without master, but web browsers need it
      fs.writeFileSync(path.join(tempDir, 'master.m3u8'), masterPlaylist);
      console.log(`[${requestId}] [HLS] Created master.m3u8 (${isSingleVariant ? 'single' : 'dual'}-variant)`);

      const variantDescription = isSingleVariant ? `Single-variant (${referenceDim}p)` : 'Dual-variant';
      console.log(`[${requestId}] [SUCCESS] ${variantDescription} HLS conversion completed`);
      
      // Upload HLS content to IPFS
      const escapedPath = escapeShellArg(tempDir);
      const cidOutput = await executeLeitherCommand(`ipfs add ${escapedPath}`, requestId, 6 * 60 * 60 * 1000); // 6 hours for IPFS add
      
      // Extract CID from output
      const trimmedOutput = cidOutput.trim();
      const ipfsAddOkMatch = trimmedOutput.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
      if (ipfsAddOkMatch) {
        cid = ipfsAddOkMatch[1];
      } else {
        const cidMatch = trimmedOutput.match(/(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/);
        if (cidMatch) {
          cid = cidMatch[1];
        }
      }
      
      if (!cid) {
        throw new Error('Failed to extract CID from IPFS add output for HLS content');
      }
      
      console.log(`[${requestId}] [SUCCESS] HLS content uploaded to IPFS, CID: ${cid}`);
    }

    // CID is already extracted in the normalization section above
    // Send response with proper headers to ensure delivery
    console.log(`\n[${requestId}] [STEP 5] Sending response...`);
    
    // Send response with proper headers to ensure delivery
    res.setHeader('Content-Type', 'application/json');
    const responseMessage = 'Video normalized, converted to HLS and stored successfully';
    
    res.setHeader('Content-Length', Buffer.byteLength(JSON.stringify({
      success: true,
      message: responseMessage,
      cid: cid,
      tempDir: tempDir
    })));
    
    res.end(JSON.stringify({
      success: true,
      message: responseMessage,
      cid: cid,
      tempDir: tempDir
    }));

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
    if (uploadedFile && uploadedFile.tempFilePath && fs.existsSync(uploadedFile.tempFilePath)) {
      try {
        fs.unlinkSync(uploadedFile.tempFilePath);
        console.log(`[${requestId}] [CLEANUP] Removed temporary uploaded file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        console.error(`[${requestId}] [ERROR] Failed to cleanup uploaded file:`, cleanupError);
      }
    }
    
    // Unregister temp directory from active set (allows future cleanup)
    if (tempDir) {
      activeTempDirs.delete(tempDir);
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
  let displayWidth = null;
  let displayHeight = null;
  let videoInfo = null;

  try {
    // Cleanup old temporary files (will skip any in activeTempDirs)
    console.log(`[${jobId}] [CLEANUP] Cleaning up old temporary files...`);
    cleanupOldTempFiles();

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
    
    // Register this temp directory to prevent cleanup
    activeTempDirs.add(tempDir);

    // Get video dimensions (always needed for routing and normalization decisions)
    let videoInfo = null;

    console.log(`\n[${jobId}] [STEP 3] Getting video dimensions${noResample ? ' (noResample=true, will preserve original)' : ''}...`);
    const getVideoInfoInternal = () => {
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
                const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
                
                console.log(`[${jobId}] [INFO] Original video bitrate: ${originalBitrate ? (originalBitrate / 1000).toFixed(0) + 'k' : 'unknown'}`);
                console.log(`[${jobId}] [INFO] Audio stream detected: ${hasAudio}`);
                
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
                  bitrate: originalBitrate,
                  hasAudio: hasAudio
                });
              } catch (parseError) {
                console.error(`[${jobId}] [ERROR] Failed to parse ffprobe JSON:`, parseError);
                reject(new Error(`Failed to parse video metadata: ${parseError.message}`));
              }
            })
            .catch(reject);
        });
      };

    videoInfo = await getVideoInfoInternal();
    console.log(`[${jobId}] [INFO] Video dimensions: ${videoInfo.width}x${videoInfo.height}, duration: ${videoInfo.duration}s`);

    displayWidth = videoInfo.displayWidth || videoInfo.width;
    displayHeight = videoInfo.displayHeight || videoInfo.height;
    console.log(`[${jobId}] [INFO] Display orientation: ${displayHeight > displayWidth ? 'Portrait' : 'Landscape'} (${displayWidth}x${displayHeight})`);
    if (videoInfo.rotation !== 0) {
      console.log(`[${jobId}] [INFO] Video has rotation: ${videoInfo.rotation}°`);
    }

    // Normalize video to MP4 format
    console.log(`\n[${jobId}] [STEP 4] Normalizing video...`);
    console.time(`[${jobId}] video-normalization`);

    // Update progress (safe - never decreases)
    updateProgressSafe(jobId, 40, 'Normalizing video...');
    
    if (!displayWidth || !displayHeight) {
      throw new Error('Cannot determine video dimensions for normalization');
    }
    
    const videoResolution = getVideoResolution(displayWidth, displayHeight);
    console.log(`[${jobId}] [INFO] Video resolution: ${videoResolution}p`);
    
    // Get source video bitrate (in bps, convert to kbps)
    const sourceBitrateKInternal = videoInfo && videoInfo.bitrate ? Math.floor(videoInfo.bitrate / 1000) : null;

    // Determine normalization parameters based on resolution
    let targetWidth, targetHeight, bitrate;

    if (noResample) {
      // Preserve Quality: cap at 1080p, keep original if already ≤1080p
      if (videoResolution > 1080) {
        console.log(`[${jobId}] [NORMALIZE] noResample=true, video (${videoResolution}p) > 1080p, normalizing to 1080p`);
        const isPortrait = displayHeight > displayWidth;
        if (isPortrait) {
          targetWidth = 1080;
          targetHeight = Math.round((1080 * displayHeight) / displayWidth);
        } else {
          targetHeight = 1080;
          targetWidth = Math.round((1080 * displayWidth) / displayHeight);
        }
        const evenDims = ensureEvenDimensions(targetWidth, targetHeight);
        targetWidth = evenDims.width;
        targetHeight = evenDims.height;
        bitrate = calculateVideoBitrateK(1080);
      } else {
        console.log(`[${jobId}] [NORMALIZE] noResample=true, video (${videoResolution}p) ≤ 1080p, keeping original resolution`);
        const evenDims = ensureEvenDimensions(displayWidth, displayHeight);
        targetWidth = evenDims.width;
        targetHeight = evenDims.height;
        bitrate = calculateVideoBitrateK(videoResolution);
      }
    } else if (videoResolution > 720) {
      // >720p: normalize to 720p with shared bitrate
      console.log(`[${jobId}] [NORMALIZE] Video resolution (${videoResolution}p) > 720p, normalizing to 720p with shared bitrate`);
      const isPortrait = displayHeight > displayWidth;
      if (isPortrait) {
        targetWidth = 720;
        targetHeight = Math.round((720 * displayHeight) / displayWidth);
      } else {
        targetHeight = 720;
        targetWidth = Math.round((720 * displayWidth) / displayHeight);
      }
      const evenDims = ensureEvenDimensions(targetWidth, targetHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      bitrate = calculateVideoBitrateK(720);
    } else if (videoResolution === 720) {
      // =720p: keep resolution, use shared bitrate
      console.log(`[${jobId}] [NORMALIZE] Video resolution is 720p, keeping resolution with shared bitrate`);
      const evenDims = ensureEvenDimensions(displayWidth, displayHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      bitrate = calculateVideoBitrateK(720);
    } else {
      // <720p: keep resolution, use shared bitrate
      console.log(`[${jobId}] [NORMALIZE] Video resolution (${videoResolution}p) < 720p, keeping resolution with shared bitrate`);
      const evenDims = ensureEvenDimensions(displayWidth, displayHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      bitrate = calculateVideoBitrateK(videoResolution);
    }

    const calculatedBitrateKInternal = bitrate;
    bitrate = capBitrateToSourceK(calculatedBitrateKInternal, sourceBitrateKInternal, `[${jobId}]`);

    console.log(`[${jobId}] [INFO] Normalization target: ${targetWidth}x${targetHeight}, source bitrate: ${sourceBitrateKInternal}k, calculated target: ${calculatedBitrateKInternal}k, final bitrate: ${bitrate}k`);
    
    // Check if scaling is needed (target dimensions differ from original)
    const needsScaling = targetWidth !== displayWidth || targetHeight !== displayHeight;

    const rotation = videoInfo ? (videoInfo.rotation || 0) : 0;
    const transposeFilter = rotation === 90 ? 'transpose=1'
                          : rotation === -90 || rotation === 270 ? 'transpose=2'
                          : rotation === 180 ? 'transpose=2,transpose=2'
                          : '';
    const needsRotation = transposeFilter !== '';

    // Get encoder config - force re-encoding if scaling or rotation is needed
    const availableEncoders = await detectHardwareEncoders();
    const encoderConfig = await getOptimalEncoder(availableEncoders, videoInfo, !needsScaling && !needsRotation);

    // If copy encoder was selected but we need scaling or rotation, force re-encoding
    let finalEncoder = encoderConfig.encoder;
    if ((encoderConfig.useCopy || encoderConfig.encoder === 'copy') && (needsScaling || needsRotation)) {
      console.log(`[${jobId}] [NORMALIZE] Filter needed (scaling=${needsScaling}, rotation=${needsRotation}) but copy encoder selected, forcing re-encoding with libx264`);
      finalEncoder = 'libx264';
      encoderConfig.hardware = false;
      encoderConfig.preset = 'fast';
    }

    const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(finalEncoder, encoderConfig.is10Bit) : '';
    const softwareParams = encoderConfig.hardware ? '' : '-preset fast -tune zerolatency -threads 2';

    let vfFilter = '';
    if (needsRotation && needsScaling) {
      vfFilter = `-vf "${transposeFilter},scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2"`;
    } else if (needsRotation) {
      vfFilter = `-vf "${transposeFilter}"`;
    } else if (needsScaling) {
      vfFilter = `-vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2"`;
    }
    if (needsRotation) {
      console.log(`[${jobId}] [NORMALIZE] Applying rotation correction: ${transposeFilter} (source rotation=${rotation}°)`);
    }

    // Keep the proven normalize-then-HLS pipeline as the default. The single-pass
    // filter graph is available as an experimental opt-in path.
    const singlePassHlsEnabled = process.env.HLS_SINGLE_PASS_FILTER_COMPLEX === 'true';
    const normalizedIsPortrait = targetHeight > targetWidth;
    const normalizedReferenceDim = normalizedIsPortrait ? targetWidth : targetHeight;
    const shouldCreateDualVariantHLS = !noResample && normalizedReferenceDim > 480;

    if (singlePassHlsEnabled && shouldCreateDualVariantHLS) {
      console.log(`[${jobId}] [HLS-SINGLE-PASS] Trying direct filter_complex dual-variant HLS from original upload`);
      try {
        const highQualityWidth = targetWidth;
        const highQualityHeight = targetHeight;
        const highQualityBitrate = calculateVideoBitrateK(normalizedReferenceDim);
        const target480Dim = Math.min(normalizedReferenceDim, 480);
        let variant480Width, variant480Height;

        if (normalizedIsPortrait) {
          variant480Width = target480Dim;
          variant480Height = Math.round((target480Dim * targetHeight) / targetWidth);
        } else {
          variant480Height = target480Dim;
          variant480Width = Math.round((target480Dim * targetWidth) / targetHeight);
        }

        const variant480EvenDims = ensureEvenDimensions(variant480Width, variant480Height);
        variant480Width = variant480EvenDims.width;
        variant480Height = variant480EvenDims.height;
        const variant480Bitrate = calculateVideoBitrateK(target480Dim);

        const segmentDurationHigh = calculateOptimalSegmentDuration({
          displayWidth: highQualityWidth,
          displayHeight: highQualityHeight,
          duration: videoInfo ? videoInfo.duration : null
        }, highQualityBitrate);
        const segmentDuration480 = calculateOptimalSegmentDuration({
          displayWidth: variant480Width,
          displayHeight: variant480Height,
          duration: videoInfo ? videoInfo.duration : null
        }, variant480Bitrate);
        // Keep both variants on the same segment cadence for smoother HLS level switches.
        const segmentDuration = Math.max(segmentDurationHigh, segmentDuration480);
        const frameRate = videoInfo && videoInfo.frameRate ? videoInfo.frameRate : 30;

        console.log(`[${jobId}] [HLS-SINGLE-PASS] 720p variant: ${highQualityWidth}x${highQualityHeight} @ ${highQualityBitrate}k`);
        console.log(`[${jobId}] [HLS-SINGLE-PASS] 480p variant: ${variant480Width}x${variant480Height} @ ${variant480Bitrate}k`);
        console.log(`[${jobId}] [HLS-SINGLE-PASS] Segment duration: ${segmentDuration}s, audio: ${videoInfo.hasAudio ? 'yes' : 'no'}`);

        const directHlsCommand = createSinglePassDualHLSCommand({
          inputPath: uploadedFile.tempFilePath,
          tempDir,
          videoInfo,
          highQualityWidth,
          highQualityHeight,
          highQualityBitrate,
          variant480Width,
          variant480Height,
          variant480Bitrate,
          segmentDuration,
          frameRate,
          hasAudio: videoInfo.hasAudio
        });

        updateProgressSafe(jobId, 40, 'Converting directly to HLS...');
        await executeWithProgress(
          directHlsCommand,
          jobId,
          40,
          80,
          'Converting directly to dual-variant HLS...',
          uploadedFile.size,
          videoInfo && videoInfo.duration ? videoInfo.duration : 0
        );

        const expectedHlsFiles = [
          path.join(tempDir, 'master.m3u8'),
          path.join(tempDir, '720p/playlist.m3u8'),
          path.join(tempDir, '480p/playlist.m3u8')
        ];
        const missingHlsFile = expectedHlsFiles.find(filePath => !fs.existsSync(filePath));
        if (missingHlsFile) {
          throw new Error(`Single-pass HLS output missing expected file: ${missingHlsFile}`);
        }

        updateProgressSafe(jobId, 80, 'Storing HLS stream...');
        const cidOutput = await executeLeitherOperationWithProgress(
          `ipfs add ${escapeShellArg(tempDir)}`,
          jobId,
          80,
          100,
          'Storing HLS stream...',
          6 * 60 * 60 * 1000
        );
        const cid = extractCidFromLeitherOutput(cidOutput);
        if (!cid) {
          throw new Error('Failed to extract CID from IPFS add output for single-pass HLS content');
        }

        console.log(`[${jobId}] [SUCCESS] Single-pass dual-variant HLS uploaded to IPFS, CID: ${cid}`);
        return {
          cid,
          tempDir,
          mediaType: 'hls_video',
          size: getPathSizeSync(tempDir),
          aspectRatio: targetWidth / targetHeight
        };
      } catch (singlePassError) {
        console.warn(`[${jobId}] [HLS-SINGLE-PASS] Direct filter_complex HLS failed, falling back to normalized pipeline: ${singlePassError.message}`);
        cleanupPartialHLSOutput(tempDir);
        updateProgressSafe(jobId, 40, 'Single-pass HLS failed, falling back to normalized pipeline...');
      }
    } else if (!singlePassHlsEnabled) {
      console.log(`[${jobId}] [HLS-SINGLE-PASS] Disabled; set HLS_SINGLE_PASS_FILTER_COMPLEX=true to enable`);
    }

    // Normalize to MP4
    const normalizedFilePath = path.join(tempDir, 'normalized.mp4');
    const isCopyNormalize = finalEncoder === 'copy';
    const ffmpegCmd = `ffmpeg -i ${escapeShellArg(uploadedFile.tempFilePath)} -c:v ${finalEncoder}${hwParams ? ` ${hwParams}` : ''} -c:a aac -b:v ${bitrate}k -b:a ${HLS_AUDIO_BITRATE}k${vfFilter ? ` ${vfFilter}` : ''} -movflags +faststart ${escapeShellArg(normalizedFilePath)} -y${softwareParams ? ` ${softwareParams}` : ''}`;

    console.log(`[${jobId}] [SERVER-UPLOAD] Normalization decision: encoder=${finalEncoder}, copy=${isCopyNormalize}, needsScaling=${needsScaling}, needsRotation=${needsRotation}, hwParams="${hwParams || 'none'}", softwareParams="${softwareParams || 'none'}", vf="${vfFilter || 'none'}"`);
    console.log(`[${jobId}] [FFMPEG] Normalize command: ${ffmpegCmd}`);
    console.log(`[${jobId}] [FFMPEG] Running normalization command...`);
    await executeWithProgress(ffmpegCmd, jobId, 40, 60, 'Normalizing video...', uploadedFile.size, videoInfo && videoInfo.duration ? videoInfo.duration : 0);
    await logMediaProbe('normalized.mp4', normalizedFilePath, `[${jobId}]`);
    
    const normalizedFileSize = fs.statSync(normalizedFilePath).size;
    const normalizedFileSizeMB = normalizedFileSize / (1024 * 1024);
    const normalizedAspectRatio = targetWidth / targetHeight;
    const normalizedVideoCodec = getNormalizedVideoCodec(videoInfo ? videoInfo.codec : null, finalEncoder);
    const copyBitstreamFilter = getMp4ToAnnexBFilterForCodec(normalizedVideoCodec);
    console.log(`[${jobId}] [INFO] Normalized file size: ${normalizedFileSizeMB.toFixed(2)}MB`);
    console.log(`[${jobId}] [SERVER-UPLOAD] Normalized codec for HLS copy=${normalizedVideoCodec || 'unknown'}, bitstreamFilter=${copyBitstreamFilter}`);
    
    console.timeEnd(`[${jobId}] video-normalization`);
    
    let cid;
    let mediaType;
    let outputSize;

    if (normalizedFileSizeMB <= HLS_CONVERSION_CUTOFF_MB) {
      console.log(`[${jobId}] [ROUTE] Normalized file size (${normalizedFileSizeMB.toFixed(2)}MB) <= ${HLS_CONVERSION_CUTOFF_MB}MB, uploading as progressive video`);
      updateProgressSafe(jobId, 80, 'Storing progressive video...');

      const cidOutput = await executeLeitherOperationWithProgress(
        `ipfs add ${escapeShellArg(normalizedFilePath)}`,
        jobId,
        80,
        100,
        'Storing progressive video...',
        600000
      );
      cid = extractCidFromLeitherOutput(cidOutput);
      if (!cid) {
        throw new Error('Failed to extract CID from IPFS add output for progressive video');
      }

      mediaType = 'video';
      outputSize = normalizedFileSize;
      console.log(`[${jobId}] [SUCCESS] Progressive video uploaded to IPFS, CID: ${cid}`);
    } else {
      console.log(`[${jobId}] [ROUTE] Normalized file size (${normalizedFileSizeMB.toFixed(2)}MB) > ${HLS_CONVERSION_CUTOFF_MB}MB, converting to HLS`);

      // Get normalized resolution (after normalization, max resolution is 720p)
      const normalizedResolution = getVideoResolution(targetWidth, targetHeight);
      console.log(`[${jobId}] [HLS] Normalized resolution: ${normalizedResolution}p (${targetWidth}x${targetHeight})`);

      // HLS conversion: single variant for 480p videos, dual variant for others (like iOS)
      // - Resolution =480p: Single 480p variant (like iOS singleVariant480p=true)
      // - Resolution >720p: High quality 720p + 480p using shared bitrate
      // - Resolution =720p: High quality 720p + 480p using shared bitrate
      // - Resolution <720p & !=480p: High quality at original resolution + 480p using shared bitrate

      // Determine if portrait or landscape
      const isPortrait = targetHeight > targetWidth;
      const referenceDim = isPortrait ? targetWidth : targetHeight;

      // Check if this video should use single variant mode
      // 480p videos: single variant (like iOS singleVariant480p=true)
      // Videos with resolution <= 480p that would create identical variants: single variant (optimization)
      const is480pVideo = referenceDim === 480;
      const wouldCreateIdenticalVariants = referenceDim <= 480 && !is480pVideo; // 360p, 240p, etc. create identical variants

      let variantCount, variantType;
      if (noResample) {
        variantCount = 1;
        variantType = `single (${referenceDim}p high quality)`;
        console.log(`[${jobId}] [HLS] noResample=true - using single high-quality variant at ${targetWidth}x${targetHeight}`);
      } else if (is480pVideo || wouldCreateIdenticalVariants) {
        variantCount = 1;
        variantType = `single (${referenceDim}p only)`;
        const reason = is480pVideo ? 'like iOS' : 'identical variants optimization';
        console.log(`[${jobId}] [HLS] ${referenceDim}p video detected - using single variant mode (${reason})`);
      } else {
        variantCount = 2;
        variantType = 'dual (720p + 480p)';
        console.log(`[${jobId}] [HLS] Creating dual-variant HLS - Original resolution: ${normalizedResolution}p (${targetWidth}x${targetHeight})`);
      }

      // Determine high-quality variant dimensions and bitrate (only if not single variant)
      let highQualityWidth, highQualityHeight, highQualityBitrate;
      let variant480Width, variant480Height, variant480Bitrate;

      if (!(is480pVideo || wouldCreateIdenticalVariants)) {
        // High-quality variant (720p or original resolution)
        if (referenceDim > 720) {
          // Resolution >720p: normalize to 720p @ shared bitrate
          console.log(`[${jobId}] [HLS] Video resolution >720p, high quality: 720p @ shared bitrate`);
          if (isPortrait) {
            highQualityWidth = 720;
            highQualityHeight = Math.round((720 * targetHeight) / targetWidth);
          } else {
            highQualityHeight = 720;
            highQualityWidth = Math.round((720 * targetWidth) / targetHeight);
          }
          highQualityBitrate = calculateVideoBitrateK(720);
        } else if (referenceDim === 720) {
          // Resolution =720p: keep at 720p using shared bitrate
          console.log(`[${jobId}] [HLS] Video resolution =720p, high quality: 720p @ ${calculateVideoBitrateK(720)}k`);
          highQualityWidth = targetWidth;
          highQualityHeight = targetHeight;
          highQualityBitrate = calculateVideoBitrateK(720);
        } else {
          // Resolution <720p: keep original resolution with shared bitrate
          console.log(`[${jobId}] [HLS] Video resolution <720p, high quality: original @ shared bitrate`);
          highQualityWidth = targetWidth;
          highQualityHeight = targetHeight;

          highQualityBitrate = calculateVideoBitrateK(referenceDim);
        }

        // Ensure even dimensions for high quality
        const highQualityEvenDims = ensureEvenDimensions(highQualityWidth, highQualityHeight);
        highQualityWidth = highQualityEvenDims.width;
        highQualityHeight = highQualityEvenDims.height;
      }

      // Always create 480p variant (or single 480p variant for 480p videos)
      const target480Dim = Math.min(referenceDim, 480); // Don't upscale

      if (isPortrait) {
        variant480Width = target480Dim;
        variant480Height = Math.round((target480Dim * targetHeight) / targetWidth);
      } else {
        variant480Height = target480Dim;
        variant480Width = Math.round((target480Dim * targetWidth) / targetHeight);
      }

      // Ensure even dimensions for 480p
      const variant480EvenDims = ensureEvenDimensions(variant480Width, variant480Height);
      variant480Width = variant480EvenDims.width;
      variant480Height = variant480EvenDims.height;

      // 480p bitrate follows the shared preserve-quality curve
      variant480Bitrate = calculateVideoBitrateK(target480Dim);

      if (highQualityBitrate) {
        highQualityBitrate = capBitrateToSourceK(highQualityBitrate, bitrate, `[${jobId}] [HLS]`);
      }
      variant480Bitrate = capBitrateToSourceK(variant480Bitrate, bitrate, `[${jobId}] [HLS]`);

      if (!is480pVideo && !noResample) {
        console.log(`[${jobId}] [HLS] High quality variant: ${highQualityWidth}x${highQualityHeight} @ ${highQualityBitrate}k`);
      }
      if (!noResample) {
        console.log(`[${jobId}] [HLS] 480p variant: ${variant480Width}x${variant480Height} @ ${variant480Bitrate}k (shared bitrate curve, ${target480Dim}p reference)`);
      }

      const isSingleVariant = noResample || is480pVideo || wouldCreateIdenticalVariants;
      const singleVarWidth = noResample ? targetWidth : variant480Width;
      const singleVarHeight = noResample ? targetHeight : variant480Height;
      const singleVarBitrate = noResample ? bitrate : variant480Bitrate;

      // Create directories based on variant mode
      if (isSingleVariant) {
        // Single variant: no subdirectories needed, playlist and segments go to root
        // Directory already created by caller
      } else {
        // Dual variant: create subdirectories for both variants
        fs.mkdirSync(path.join(tempDir, '720p'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '480p'), { recursive: true });
      }

      // Check if we can use COPY encoder for HLS conversion
      // Matches iOS logic: COPY is used based on resolution ranges, not exact dimensions
      const normalizedIsPortrait = targetHeight > targetWidth;
      const normalizedReferenceDim = normalizedIsPortrait ? targetWidth : targetHeight;

      const canUseCopySingle = isSingleVariant && (noResample || normalizedReferenceDim <= 480);
      const canUseCopyDual720 = !isSingleVariant && (normalizedReferenceDim > 480 && normalizedReferenceDim <= 720);

      console.log(`[${jobId}] [HLS] Normalized video: ${targetWidth}x${targetHeight} (${normalizedReferenceDim}p)`);
      if (isSingleVariant) {
        console.log(`[${jobId}] [HLS] Single variant target: ${singleVarWidth}x${singleVarHeight}, can use COPY: ${canUseCopySingle} (${noResample ? 'noResample' : 'normalized ≤480p'})`);
      } else {
        console.log(`[${jobId}] [HLS] Dual variant 720p target: ${highQualityWidth}x${highQualityHeight}, can use COPY: ${canUseCopyDual720} (normalized >480p and ≤720p)`);
        console.log(`[${jobId}] [HLS] Dual variant 480p target: ${variant480Width}x${variant480Height}, needs scaling`);
      }

      // Use hardware encoder if available for better performance
      const availableEncoders = await detectHardwareEncoders();
      let encoderConfig = await getOptimalEncoder(availableEncoders, {
        width: isSingleVariant ? singleVarWidth : highQualityWidth,
        height: isSingleVariant ? singleVarHeight : highQualityHeight,
        displayWidth: isSingleVariant ? singleVarWidth : highQualityWidth,
        displayHeight: isSingleVariant ? singleVarHeight : highQualityHeight
      }, false);

      // Safety check
      if (!encoderConfig || !encoderConfig.encoder || typeof encoderConfig.encoder !== 'string') {
        console.warn(`[${jobId}] [HARDWARE] Invalid encoder config, falling back to libx264`);
        encoderConfig = { encoder: 'libx264', preset: 'fast', hardware: false, is10Bit: false };
      }

      const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder, encoderConfig.is10Bit) : '';
      const softwareParams = encoderConfig.hardware ? '' : `-preset ${encoderConfig.preset || 'fast'} -tune zerolatency -threads 2`;

      // Calculate segment duration for single variant based on singleVar dimensions/bitrate
      const segmentDurationSingle = calculateOptimalSegmentDuration({
        displayWidth: singleVarWidth,
        displayHeight: singleVarHeight,
        duration: videoInfo ? videoInfo.duration : null
      }, singleVarBitrate);

      // Get frame rate for GOP size calculation (default to 30fps if not available)
      const frameRate = videoInfo && videoInfo.frameRate ? videoInfo.frameRate : 30;

      // Calculate keyframe parameters for smooth HLS playback
      const keyframeParamsSingle = getHLSKeyframeParams(segmentDurationSingle, frameRate);

      let commands = [];
      let masterPlaylist = '';

      if (isSingleVariant) {
        // Single variant: playlist and segments at root level (simplified HLS structure)
        let cmd;
        if (canUseCopySingle) {
          console.log(`[${jobId}] [HLS] Using COPY encoder for single variant (no scaling needed)`);
          cmd = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v copy -c:a aac -b:a ${HLS_AUDIO_BITRATE}k -fflags +genpts+igndts -bsf:v ${copyBitstreamFilter} -avoid_negative_ts make_zero -f hls -hls_time ${segmentDurationSingle} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
        } else {
          console.log(`[${jobId}] [HLS] Using libx264 encoder for single variant (scaling needed)`);
          cmd = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${singleVarWidth}:${singleVarHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParamsSingle} -b:v ${singleVarBitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDurationSingle} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, 'segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, 'playlist.m3u8'))}`;
        }

        commands = [
          { cmd: cmd, variant: `${referenceDim}p`, progressStart: 60, progressEnd: 80 }
        ];

        masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${singleVarBitrate * 1000 + HLS_AUDIO_BITRATE_BPS},RESOLUTION=${singleVarWidth}x${singleVarHeight}
playlist.m3u8`;

        updateProgressSafe(jobId, 60, 'Converting to single-variant HLS...');
        console.log(`[${jobId}] [HLS] Executing single-variant HLS conversion for ${referenceDim}p video...`);
      } else {
        // Dual variant: 720p + 480p
        const segmentDuration720 = calculateOptimalSegmentDuration({
          displayWidth: highQualityWidth,
          displayHeight: highQualityHeight,
          duration: videoInfo ? videoInfo.duration : null
        }, highQualityBitrate);

        // Calculate keyframe parameters for both variants
        const keyframeParams720 = getHLSKeyframeParams(segmentDuration720, frameRate);
        const segmentDuration480 = calculateOptimalSegmentDuration({
          displayWidth: variant480Width,
          displayHeight: variant480Height,
          duration: videoInfo ? videoInfo.duration : null
        }, variant480Bitrate);
        const keyframeParams480 = getHLSKeyframeParams(segmentDuration480, frameRate);

        // 720p variant: use COPY if dimensions match, otherwise libx264
        let cmd720p;
        if (canUseCopyDual720) {
          console.log(`[${jobId}] [HLS] Using COPY encoder for 720p variant (no scaling needed)`);
          cmd720p = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v copy -c:a aac -b:a ${HLS_AUDIO_BITRATE}k -fflags +genpts+igndts -bsf:v ${copyBitstreamFilter} -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration720} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
        } else {
          console.log(`[${jobId}] [HLS] Using libx264 encoder for 720p variant (scaling needed)`);
          cmd720p = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${highQualityWidth}:${highQualityHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams720} -b:v ${highQualityBitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration720} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '720p/playlist.m3u8'))}`;
        }

        // 480p variant: always use libx264 (always needs scaling)
        console.log(`[${jobId}] [HLS] Using libx264 encoder for 480p variant (scaling needed)`);
        const cmd480p = `ffmpeg -i ${escapeShellArg(normalizedFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${variant480Width}:${variant480Height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams480} -b:v ${variant480Bitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration480} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(tempDir, '480p/segment%03d.ts'))} ${escapeShellArg(path.join(tempDir, '480p/playlist.m3u8'))}`;

        commands = [
          { cmd: cmd720p, variant: '720p', progressStart: 60, progressEnd: 70 },
          { cmd: cmd480p, variant: '480p', progressStart: 70, progressEnd: 80 }
        ];

        // Create master playlist for dual variant
        const bandwidth720 = highQualityBitrate * 1000 + HLS_AUDIO_BITRATE_BPS; // video + audio
        const bandwidth480 = variant480Bitrate * 1000 + HLS_AUDIO_BITRATE_BPS;

        masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth720},RESOLUTION=${highQualityWidth}x${highQualityHeight}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth480},RESOLUTION=${variant480Width}x${variant480Height}
480p/playlist.m3u8`;

        updateProgressSafe(jobId, 60, 'Converting to dual-variant HLS...');
        console.log(`[${jobId}] [HLS] Executing dual-variant HLS conversion...`);
      }

      // Execute HLS conversion commands
      commands.forEach(command => {
        console.log(`[${jobId}] [FFMPEG] HLS command (${command.variant}): ${command.cmd}`);
      });
      await Promise.all(commands.map((command, index) =>
        executeWithProgress(
          command.cmd,
          jobId,
          command.progressStart,
          command.progressEnd,
          `Converting to ${command.variant} HLS...`,
          normalizedFileSize,
          videoInfo && videoInfo.duration ? videoInfo.duration : 0
        )
      ));

      // Delete normalized.mp4 file after HLS conversion (cleanup)
      console.log(`[${jobId}] [CLEANUP] Deleting normalized.mp4 from HLS directory...`);
      try {
        if (fs.existsSync(normalizedFilePath)) {
          fs.unlinkSync(normalizedFilePath);
          console.log(`[${jobId}] [CLEANUP] Successfully deleted normalized.mp4`);
        }
      } catch (cleanupError) {
        console.warn(`[${jobId}] [CLEANUP] Failed to delete normalized.mp4:`, cleanupError.message);
      }

      // Create master playlist file for all HLS conversions (needed for web browser compatibility)
      // Even single variants need master.m3u8 because web players try to load it first
      fs.writeFileSync(path.join(tempDir, 'master.m3u8'), masterPlaylist);
      console.log(`[${jobId}] [HLS] Created master.m3u8 (${isSingleVariant ? 'single' : 'dual'}-variant)`);

      const variantDescription = isSingleVariant ? `Single-variant (${referenceDim}p)` : 'Dual-variant';
      console.log(`[${jobId}] [SUCCESS] ${variantDescription} HLS conversion completed`);
      
      // Store HLS bundle in content-addressed storage
      updateProgressSafe(jobId, 80, 'Storing HLS stream...');

      const escapedPath = escapeShellArg(tempDir);
      const cidOutput = await executeLeitherOperationWithProgress(
        `ipfs add ${escapedPath}`,
        jobId,
        80,
        100,
        'Storing HLS stream...',
        6 * 60 * 60 * 1000 // 6 hours for IPFS add
      );
      
      // Extract CID from output
      const trimmedOutput = cidOutput.trim();
      const ipfsAddOkMatch = trimmedOutput.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
      if (ipfsAddOkMatch) {
        cid = ipfsAddOkMatch[1];
      } else {
        const cidMatch = trimmedOutput.match(/(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/);
        if (cidMatch) {
          cid = cidMatch[1];
        }
      }
      
      if (!cid) {
        throw new Error('Failed to extract CID from IPFS add output for HLS content');
      }
      
      mediaType = 'hls_video';
      outputSize = normalizedFileSize;
      console.log(`[${jobId}] [SUCCESS] HLS content uploaded to IPFS, CID: ${cid}`);
    }
    
    console.timeEnd(`[${jobId}] video-normalization`);
    
    // NOTE: The IPFS gateway server must send proper CORS headers for HLS segments to work
    // Required headers: Access-Control-Allow-Origin, Access-Control-Allow-Methods, Access-Control-Allow-Headers (Range)
    // See docs/HLS_CORS_REQUIREMENTS.md for configuration details

    // Process with Leither
    console.log(`\n[${jobId}] [STEP 5] Processing with Leither service...`);
    console.time(`[${jobId}] leither-total-time`);
    let timingLabels = new Set();
    
    // Update progress (safe - never decreases)
    updateProgressSafe(jobId, 100, 'Processing complete');
    
    try {
      console.time(`[${jobId}] leither-total-time`);
      timingLabels.add('leither-total-time');
      
      return { cid, tempDir, mediaType, size: outputSize, aspectRatio: normalizedAspectRatio };

    } catch (leitherError) {
      console.error(`[${jobId}] [FATAL] Leither service error:`, leitherError);
      
      // Clean up any active timing labels
      const labelsToClean = ['leither-total-time'];
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
    if (uploadedFile && uploadedFile.tempFilePath && fs.existsSync(uploadedFile.tempFilePath)) {
      try {
        fs.unlinkSync(uploadedFile.tempFilePath);
        console.log(`[${jobId}] [CLEANUP] Removed temporary uploaded file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        console.error(`[${jobId}] [ERROR] Failed to cleanup uploaded file:`, cleanupError);
      }
    }
    
    // Unregister temp directory from active set (allows future cleanup)
    if (tempDir) {
      activeTempDirs.delete(tempDir);
    }
    
    console.log(`[${jobId}] [INFO] Total route processing time: ${Date.now() - routeStartTime}ms`);
    console.log(`[${jobId}] [INFO] HLS files preserved in: ${tempDir}`);
    console.log(`[${new Date().toISOString()}] [${jobId}] --- /convert-video route processing finished ---\n`);
  }
}

// Store for tracking video processing status
const processingJobs = new Map();

// Store for tracking video normalization status
const normalizeJobs = new Map();

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
  console.log(`[${jobId}] [SERVER-UPLOAD] Accepted /convert-video request from ${req.ip || req.socket.remoteAddress || 'unknown'} contentLength=${req.headers['content-length'] || 'unknown'}`);
  
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
    console.log(`[${jobId}] [SERVER-UPLOAD] File ready for background conversion: name="${uploadedFile.name}", sizeMB=${(uploadedFile.size / (1024 * 1024)).toFixed(2)}, mimetype="${uploadedFile.mimetype || 'unknown'}", noResample=${req.body ? req.body.noResample : 'unknown'}`);
    
    // Send immediate response with job ID
    const responseSentTime = Date.now();
    console.log(`[UPLOAD-TIMING] Sending response at ${new Date().toISOString()} (${responseSentTime - uploadStartTime}ms total upload time)`);
    
    res.json({
      success: true,
      message: 'Video upload started',
      jobId: jobId
    });
    
    console.log(`[UPLOAD-TIMING] Response sent successfully, starting background processing`);
    console.log(`[${jobId}] [SERVER-UPLOAD] Client response sent; background conversion starting now`);
    
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
    const startTime = processingJobs.get(jobId) ? processingJobs.get(jobId).startTime : Date.now();
    processingJobs.set(jobId, {
      status: 'processing',
      progress: updateProgressSafe(jobId, 20, 'Starting video processing...'),
      message: 'Starting video processing...',
      startTime: startTime
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
      mediaType: result.mediaType,
      size: result.size,
      aspectRatio: result.aspectRatio,
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

// Video normalization endpoint (for <50MB videos) - single file upload like convert-video
router.post('/normalize-video', async (req, res) => {
  const uploadStartTime = Date.now();
  console.log(`[NORMALIZE-TIMING] Upload request received at ${new Date().toISOString()}`);
  
  // Set timeout for normalization (should be quick for <50MB files)
  req.setTimeout(10 * 60 * 1000); // 10 minutes
  res.setTimeout(10 * 60 * 1000);
  
  // Handle connection close gracefully
  req.on('close', () => {
    console.log('[NORMALIZE-VIDEO] Client disconnected during upload');
  });
  
  req.on('error', (error) => {
    console.error('[NORMALIZE-VIDEO] Request error:', error);
  });
  
  res.on('close', () => {
    console.log('[NORMALIZE-VIDEO] Response closed');
  });
  
  // Generate a unique job ID
  const jobId = Math.random().toString(36).substr(2, 9);
  console.log(`[${jobId}] [SERVER-UPLOAD] Accepted /normalize-video request from ${req.ip || req.socket.remoteAddress || 'unknown'} contentLength=${req.headers['content-length'] || 'unknown'}`);
  
  // Store job status
  normalizeJobs.set(jobId, {
    status: 'uploading',
    progress: 0,
    message: 'Starting upload...',
    startTime: Date.now()
  });
  
  try {
    const requestReceivedTime = Date.now();
    console.log(`[NORMALIZE-TIMING] Request processing started at ${new Date().toISOString()} (${requestReceivedTime - uploadStartTime}ms after request received)`);
    
    // Validate upload BEFORE sending response
    if (!req.files || !req.files.videoFile) {
      console.error(`[${jobId}] [ERROR] No video file found in request. Expected a file with field name "videoFile".`);
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded. Please use the "videoFile" field name.'
      });
    }
    
    // Check file size (2GB limit)
    const uploadedFile = req.files.videoFile;
    const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
    if (uploadedFile.size > maxSize) {
      console.error(`[${jobId}] [ERROR] File size ${uploadedFile.size} exceeds limit of ${maxSize}`);
      return res.status(400).json({
        success: false,
        message: `File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 2GB for normalization.`
      });
    }
    
    console.log(`[${jobId}] [UPLOAD-DEBUG] File received: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);
    console.log(`[${jobId}] [UPLOAD-DEBUG] File path: ${uploadedFile.tempFilePath}`);
    console.log(`[${jobId}] [SERVER-UPLOAD] File ready for background normalization: name="${uploadedFile.name}", sizeMB=${(uploadedFile.size / (1024 * 1024)).toFixed(2)}, mimetype="${uploadedFile.mimetype || 'unknown'}"`);
    
    // Send immediate response with job ID
    const responseSentTime = Date.now();
    console.log(`[NORMALIZE-TIMING] Sending response at ${new Date().toISOString()} (${responseSentTime - uploadStartTime}ms total upload time)`);
    
    res.json({
      success: true,
      message: 'Video normalization started',
      jobId: jobId
    });
    
    console.log(`[NORMALIZE-TIMING] Response sent successfully, starting background processing`);
    console.log(`[${jobId}] [SERVER-UPLOAD] Client response sent; background normalization starting now`);
    
    // Process video normalization in background
    processNormalizeVideoAsync(req, jobId);
    
  } catch (error) {
    console.error(`[${jobId}] [ERROR] Failed to process video normalization:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to process video normalization: ' + error.message
      });
    }
  }
});

// Async video normalization function
async function processNormalizeVideoAsync(req, jobId) {
  console.log(`[${jobId}] Starting background video normalization...`);
  
  try {
    // Update job status to processing
    const startTime = normalizeJobs.get(jobId) ? normalizeJobs.get(jobId).startTime : Date.now();
    normalizeJobs.set(jobId, {
      status: 'processing',
      progress: 10,
      message: 'Starting video normalization...',
      startTime: startTime
    });
    
    console.log(`[${jobId}] Calling processNormalizeVideoInternal...`);
    
    // Process the video normalization (reuse existing logic from previous implementation if any)
    const result = await processNormalizeVideoInternal(req, jobId);
    
    console.log(`[${jobId}] Video normalization completed, CID:`, result.cid);
    
    // Update job status with success
    normalizeJobs.set(jobId, {
      status: 'completed',
      progress: 100,
      message: 'Video normalization completed successfully',
      cid: result.cid,
      mediaType: result.mediaType,
      size: result.size,
      aspectRatio: result.aspectRatio,
      startTime: normalizeJobs.get(jobId).startTime,
      endTime: Date.now()
    });
    
  } catch (error) {
    console.error(`[${jobId}] Background normalization failed:`, error);
    
    // Update job status with error
    normalizeJobs.set(jobId, {
      status: 'failed',
      progress: 0,
      message: error.message || 'Video normalization failed',
      error: error.message,
      startTime: normalizeJobs.get(jobId).startTime,
      endTime: Date.now()
    });
  }
}

// Internal video normalization function (OPTIMIZED algorithm)
async function processNormalizeVideoInternal(req, jobId) {
  console.log(`\n[${new Date().toISOString()}] [${jobId}] --- /normalize-video internal processing started ---`);
  
  let tempDir = null;
  let uploadedFile = null;
  let normalizedFilePath = null;
  let displayWidth = null;
  let displayHeight = null;
  let originalWidth = null;
  let originalHeight = null;
  let streamInfo = null;
  
  try {
    // Cleanup old temporary files (will skip any in activeTempDirs)
    console.log(`[${jobId}] [CLEANUP] Cleaning up old temporary files...`);
    cleanupOldTempFiles();
    
    uploadedFile = req.files.videoFile;
    console.log(`[${jobId}] [INFO] Received video: name='${uploadedFile.name}', size=${uploadedFile.size}, type='${uploadedFile.mimetype}'`);
    
    // Check file size (2GB limit for normalization endpoint)
    const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
    if (uploadedFile.size > maxSize) {
      throw new Error(`File size ${(uploadedFile.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 2GB for normalization.`);
    }
    
    // Create temporary directory for processing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-normalize-'));
    activeTempDirs.add(tempDir);
    console.log(`[${jobId}] [INFO] Created temp directory: ${tempDir}`);
    
    const inputPath = uploadedFile.tempFilePath;
    
    // Step 1: Get video information using ffprobe
    console.log(`[${jobId}] [STEP 1] Analyzing video with ffprobe...`);
    normalizeJobs.set(jobId, {
      status: 'processing',
      progress: 10,
      message: 'Analyzing video...',
      startTime: normalizeJobs.get(jobId).startTime
    });
    
    const getVideoInfo = () => {
      return execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration,bit_rate -of json ${escapeShellArg(inputPath)}`);
    };
    
    const videoInfoOutput = await getVideoInfo();
    const videoInfo = JSON.parse(videoInfoOutput.stdout);
    streamInfo = videoInfo.streams && videoInfo.streams[0];
    originalWidth = streamInfo ? streamInfo.width : null;
    originalHeight = streamInfo ? streamInfo.height : null;

    if (!originalWidth || !originalHeight) {
      throw new Error('Could not determine video dimensions');
    }
    
    console.log(`[${jobId}] [INFO] Original dimensions: ${originalWidth}x${originalHeight}`);
    
    // Handle rotation to get display dimensions
    displayWidth = originalWidth;
    displayHeight = originalHeight;
    let sourceRotation = 0;

    // Check for rotation metadata
    if (streamInfo.side_data_list) {
      for (const sideData of streamInfo.side_data_list) {
        if (sideData.side_data_type === 'Display Matrix') {
          const matrix = sideData.rotation;
          if (matrix === -90 || matrix === 90) {
            displayWidth = originalHeight;
            displayHeight = originalWidth;
          }
          sourceRotation = matrix || 0;
          break;
        }
      }
    }

    console.log(`[${jobId}] [INFO] Display dimensions (after rotation): ${displayWidth}x${displayHeight}`);
    if (sourceRotation !== 0) console.log(`[${jobId}] [INFO] Source rotation: ${sourceRotation}°`);

    // Determine video resolution using the new algorithm
    const videoResolution = getVideoResolution(displayWidth, displayHeight);
    const sourceBitrateK = streamInfo && streamInfo.bit_rate ? Math.floor(Number(streamInfo.bit_rate) / 1000) : null;
    console.log(`[${jobId}] [INFO] Video resolution: ${videoResolution}p`);

    // Step 2: Apply normalization algorithm
    console.log(`[${jobId}] [STEP 2] Applying normalization algorithm...`);
    normalizeJobs.set(jobId, {
      status: 'processing',
      progress: 20,
      message: 'Applying normalization algorithm...',
      startTime: normalizeJobs.get(jobId).startTime
    });
    
    let finalFilePath;
    let finalFileSize;
    let normalizedResolution; // Track the resolution after normalization
    
    // Always normalize videos
    const outputPath = path.join(tempDir, 'normalized.mp4');
    normalizedFilePath = outputPath;

    let targetWidth, targetHeight, bitrate;

    if (videoResolution <= 720) {
      // Normalize videos ≤ 720p at their original resolution with shared bitrate
      console.log(`[${jobId}] [NORMALIZE] Video resolution (${videoResolution}p) ≤ 720p, normalizing at original resolution with shared bitrate`);

      // Keep original dimensions but ensure even
      const evenDims = ensureEvenDimensions(displayWidth, displayHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      
      bitrate = calculateVideoBitrateK(videoResolution);
      normalizedResolution = videoResolution;
      
      console.log(`[${jobId}] [INFO] Target dimensions: ${targetWidth}x${targetHeight}, Bitrate: ${bitrate}k`);
    } else {
      // Normalize videos > 720p to 720p with shared bitrate
      console.log(`[${jobId}] [NORMALIZE] Video resolution (${videoResolution}p) > 720p, normalizing to 720p`);

      // Calculate 720p dimensions maintaining aspect ratio
      const isPortrait = displayHeight > displayWidth;

      if (isPortrait) {
        // Portrait: maintain width, calculate height
        targetWidth = 720;
        targetHeight = Math.round((720 * displayHeight) / displayWidth);
      } else {
        // Landscape: maintain height, calculate width
        targetHeight = 720;
        targetWidth = Math.round((720 * displayWidth) / displayHeight);
      }

      // Ensure even dimensions
      const evenDims = ensureEvenDimensions(targetWidth, targetHeight);
      targetWidth = evenDims.width;
      targetHeight = evenDims.height;
      
      bitrate = calculateVideoBitrateK(720); // Standard bitrate for 720p
      normalizedResolution = 720;

      console.log(`[${jobId}] [INFO] Target dimensions: ${targetWidth}x${targetHeight}, Bitrate: ${bitrate}k`);
    }

    const calculatedBitrateK = bitrate;
    bitrate = capBitrateToSourceK(calculatedBitrateK, sourceBitrateK, `[${jobId}]`);
    console.log(`[${jobId}] [INFO] Normalization bitrate: source=${sourceBitrateK}k, calculated=${calculatedBitrateK}k, final=${bitrate}k`);

    // Check if scaling is needed (target dimensions differ from original)
    const needsScaling = targetWidth !== displayWidth || targetHeight !== displayHeight;

    const transposeFilter = sourceRotation === 90 ? 'transpose=1'
                          : sourceRotation === -90 || sourceRotation === 270 ? 'transpose=2'
                          : sourceRotation === 180 ? 'transpose=2,transpose=2'
                          : '';
    const needsRotation = transposeFilter !== '';

    // Use hardware encoding if available - force re-encoding if scaling or rotation is needed
    const availableEncoders = await detectHardwareEncoders();
    const encoderConfig = await getOptimalEncoder(availableEncoders, {
      width: originalWidth,
      height: originalHeight,
      displayWidth: displayWidth,
      displayHeight: displayHeight
    }, !needsScaling && !needsRotation);

    // If copy encoder was selected but we need scaling or rotation, force re-encoding
    let finalEncoder = encoderConfig.encoder;
    if ((encoderConfig.useCopy || encoderConfig.encoder === 'copy') && (needsScaling || needsRotation)) {
      console.log(`[${jobId}] [NORMALIZE] Filter needed (scaling=${needsScaling}, rotation=${needsRotation}) but copy encoder selected, forcing re-encoding with libx264`);
      finalEncoder = 'libx264';
      encoderConfig.hardware = false;
      encoderConfig.preset = 'fast';
    }

    const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(finalEncoder, encoderConfig.is10Bit) : '';
    const softwareParams = encoderConfig.hardware ? '' : '-preset fast -tune zerolatency -threads 2';

    let vfFilter = '';
    if (needsRotation && needsScaling) {
      vfFilter = `-vf "${transposeFilter},scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2"`;
    } else if (needsRotation) {
      vfFilter = `-vf "${transposeFilter}"`;
    } else if (needsScaling) {
      vfFilter = `-vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2"`;
    }
    if (needsRotation) {
      console.log(`[${jobId}] [NORMALIZE] Applying rotation correction: ${transposeFilter} (source rotation=${sourceRotation}°)`);
    }

    const isCopyNormalize = finalEncoder === 'copy';
    const ffmpegCmd = `ffmpeg -i ${escapeShellArg(inputPath)} -c:v ${finalEncoder}${hwParams ? ` ${hwParams}` : ''} -c:a aac -b:v ${bitrate}k -b:a ${HLS_AUDIO_BITRATE}k${vfFilter ? ` ${vfFilter}` : ''} -movflags +faststart ${escapeShellArg(outputPath)} -y${softwareParams ? ` ${softwareParams}` : ''}`;
  
    console.log(`[${jobId}] [SERVER-UPLOAD] Normalization decision: encoder=${finalEncoder}, copy=${isCopyNormalize}, needsScaling=${needsScaling}, needsRotation=${needsRotation}, hwParams="${hwParams || 'none'}", softwareParams="${softwareParams || 'none'}", vf="${vfFilter || 'none'}"`);
    console.log(`[${jobId}] [FFMPEG] Normalize command: ${ffmpegCmd}`);
    console.log(`[${jobId}] [FFMPEG] Running normalization command...`);
    await execAsync(ffmpegCmd);
    await logMediaProbe('normalized.mp4', outputPath, `[${jobId}]`);
  
    finalFilePath = outputPath;
    finalFileSize = fs.statSync(outputPath).size;
    const normalizedAspectRatio = targetWidth / targetHeight;
    const normalizedVideoCodec = getNormalizedVideoCodec(streamInfo ? streamInfo.codec_name : null, finalEncoder);
    const copyBitstreamFilter = getMp4ToAnnexBFilterForCodec(normalizedVideoCodec);
    console.log(`[${jobId}] [INFO] Normalized file size: ${finalFileSize} bytes (${(finalFileSize / (1024 * 1024)).toFixed(2)}MB)`);
    console.log(`[${jobId}] [INFO] Normalized resolution: ${normalizedResolution}p`);
    console.log(`[${jobId}] [SERVER-UPLOAD] Normalized codec for HLS copy=${normalizedVideoCodec || 'unknown'}, bitstreamFilter=${copyBitstreamFilter}`);
    
    // Step 3: Route based on file size
    console.log(`[${jobId}] [STEP 3] Routing based on file size...`);
    normalizeJobs.set(jobId, {
      status: 'processing',
      progress: 40,
      message: 'Routing based on file size...',
      startTime: normalizeJobs.get(jobId).startTime
    });
    
    const fileSizeMB = finalFileSize / (1024 * 1024);
    console.log(`[${jobId}] [INFO] Final file size: ${fileSizeMB.toFixed(2)}MB`);

    let cid;
    let mediaType;
    let outputSize;

    if (fileSizeMB <= HLS_CONVERSION_CUTOFF_MB) {
      // Progressive video upload (<= cutoff)
      console.log(`[${jobId}] [ROUTE] File size (${fileSizeMB.toFixed(2)}MB) <= ${HLS_CONVERSION_CUTOFF_MB}MB, uploading as progressive video`);
      normalizeJobs.set(jobId, {
        status: 'processing',
        progress: 60,
        message: 'Uploading progressive video...',
        startTime: normalizeJobs.get(jobId).startTime
      });

      const escapedPath = escapeShellArg(finalFilePath);
    const cidOutput = await executeLeitherCommand(`ipfs add ${escapedPath}`, jobId, 600000); // 10 minutes timeout
    
    // Extract CID from output
    const trimmedOutput = cidOutput.trim();
    const ipfsAddOkMatch = trimmedOutput.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
    if (ipfsAddOkMatch) {
      cid = ipfsAddOkMatch[1];
    } else {
      const cidMatch = trimmedOutput.match(/(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/);
      if (cidMatch) {
        cid = cidMatch[1];
      }
    }
    
    if (!cid) {
      throw new Error('Failed to extract CID from IPFS add output');
    }
    
      console.log(`[${jobId}] [SUCCESS] Progressive video uploaded to IPFS, CID: ${cid}`);
      mediaType = 'video';
      outputSize = finalFileSize;

    } else {
      // HLS conversion (> cutoff)
      console.log(`[${jobId}] [ROUTE] File size (${fileSizeMB.toFixed(2)}MB) > ${HLS_CONVERSION_CUTOFF_MB}MB, converting to HLS`);

      // Dual-variant HLS conversion with normalization bitrates:
      // - Resolution >720p: High quality 720p @ shared bitrate
      // - Resolution =720p: High quality 720p using shared bitrate
      // - Resolution <720p: High quality at original resolution using shared bitrate
      // - 480p variant: Always using shared bitrate based on target resolution
      
      console.log(`[${jobId}] [HLS] Creating dual-variant HLS - Original resolution: ${videoResolution}p, Normalized resolution: ${normalizedResolution}p`);
      
      // Determine if portrait or landscape
      const isPortrait = displayHeight > displayWidth;
      const referenceDim = isPortrait ? displayWidth : displayHeight;
      
      // Determine high-quality variant dimensions and bitrate
      let highQualityWidth, highQualityHeight, highQualityBitrate;
      
      if (referenceDim > 720) {
        // Resolution >720p: normalize to 720p @ shared bitrate
        console.log(`[${jobId}] [HLS] Video resolution >720p, high quality: 720p @ shared bitrate`);
        if (isPortrait) {
          highQualityWidth = 720;
          highQualityHeight = Math.round((720 * displayHeight) / displayWidth);
        } else {
          highQualityHeight = 720;
          highQualityWidth = Math.round((720 * displayWidth) / displayHeight);
        }
        highQualityBitrate = calculateVideoBitrateK(720);
      } else if (referenceDim === 720) {
        // Resolution =720p: keep at 720p using shared bitrate
        console.log(`[${jobId}] [HLS] Video resolution =720p, high quality: 720p @ ${calculateVideoBitrateK(720)}k`);
        highQualityWidth = displayWidth;
        highQualityHeight = displayHeight;
        highQualityBitrate = calculateVideoBitrateK(720);
      } else {
        // Resolution <720p: keep original resolution with shared bitrate
        console.log(`[${jobId}] [HLS] Video resolution <720p, high quality: original @ shared bitrate`);
        highQualityWidth = displayWidth;
        highQualityHeight = displayHeight;
        
        highQualityBitrate = calculateVideoBitrateK(referenceDim);
      }
      
      // Ensure even dimensions for high quality
      const highQualityEvenDims = ensureEvenDimensions(highQualityWidth, highQualityHeight);
      highQualityWidth = highQualityEvenDims.width;
      highQualityHeight = highQualityEvenDims.height;
      
      // Calculate 480p variant dimensions (proportional to original aspect ratio, don't upscale)
      let variant480Width, variant480Height;
      const target480Dim = Math.min(referenceDim, 480); // Don't upscale
      
      if (isPortrait) {
        variant480Width = target480Dim;
        variant480Height = Math.round((target480Dim * displayHeight) / displayWidth);
      } else {
        variant480Height = target480Dim;
        variant480Width = Math.round((target480Dim * displayWidth) / displayHeight);
      }
      
      // Ensure even dimensions for 480p
      const variant480EvenDims = ensureEvenDimensions(variant480Width, variant480Height);
      variant480Width = variant480EvenDims.width;
      variant480Height = variant480EvenDims.height;

      // 480p bitrate follows the shared preserve-quality curve
      let variant480Bitrate = calculateVideoBitrateK(target480Dim);

      highQualityBitrate = capBitrateToSourceK(highQualityBitrate, bitrate, `[${jobId}] [HLS]`);
      variant480Bitrate = capBitrateToSourceK(variant480Bitrate, bitrate, `[${jobId}] [HLS]`);

      console.log(`[${jobId}] [HLS] High quality variant: ${highQualityWidth}x${highQualityHeight} @ ${highQualityBitrate}k`);
      console.log(`[${jobId}] [HLS] 480p variant: ${variant480Width}x${variant480Height} @ ${variant480Bitrate}k (shared bitrate curve, ${target480Dim}p reference)`);

      // Create HLS conversion
      const hlsTempDir = path.join(tempDir, 'hls');
      fs.mkdirSync(hlsTempDir, { recursive: true });
      
      // Create subdirectories for dual-variant HLS
      fs.mkdirSync(path.join(hlsTempDir, '720p'), { recursive: true });
      fs.mkdirSync(path.join(hlsTempDir, '480p'), { recursive: true });

      // Check if we can use COPY encoder for HLS conversion
      // Matches iOS logic: COPY is used based on resolution ranges
      // - 720p variant: use COPY if normalized resolution is between 480p and 720p (avoids upscaling)
      const canUseCopy720 = (referenceDim > 480 && referenceDim <= 720);
      
      console.log(`[${jobId}] [HLS] Normalized video: ${displayWidth}x${displayHeight} (${referenceDim}p)`);
      console.log(`[${jobId}] [HLS] 720p target: ${highQualityWidth}x${highQualityHeight}, can use COPY: ${canUseCopy720} (normalized >480p and ≤720p)`);
      console.log(`[${jobId}] [HLS] 480p target: ${variant480Width}x${variant480Height}, needs scaling`);
      
      // Use hardware encoder if available for better performance
      const availableEncoders = await detectHardwareEncoders();
      let encoderConfig = await getOptimalEncoder(availableEncoders, {
        width: highQualityWidth,
        height: highQualityHeight,
        displayWidth: highQualityWidth,
        displayHeight: highQualityHeight
      }, false);
      
      // Safety check
      if (!encoderConfig || !encoderConfig.encoder || typeof encoderConfig.encoder !== 'string') {
        console.warn(`[${jobId}] [HARDWARE] Invalid encoder config, falling back to libx264`);
        encoderConfig = { encoder: 'libx264', preset: 'fast', hardware: false, is10Bit: false };
      }

      const hwParams = encoderConfig.hardware ? getHardwareEncodingParams(encoderConfig.encoder, encoderConfig.is10Bit) : '';
      const softwareParams = encoderConfig.hardware ? '' : `-preset ${encoderConfig.preset || 'fast'} -tune zerolatency -threads 2`;

      // Calculate segment durations
      const segmentDuration720 = calculateOptimalSegmentDuration({
        displayWidth: highQualityWidth,
        displayHeight: highQualityHeight,
        duration: streamInfo ? streamInfo.duration : null
      }, highQualityBitrate);
      
      const segmentDuration480 = calculateOptimalSegmentDuration({
        displayWidth: variant480Width,
        displayHeight: variant480Height,
        duration: streamInfo ? streamInfo.duration : null
      }, variant480Bitrate);

      // Get frame rate for GOP size calculation (default to 30fps if not available)
      let frameRate = 30;
      if (streamInfo && streamInfo.r_frame_rate) {
        const [num, den] = streamInfo.r_frame_rate.split('/').map(Number);
        if (den && den > 0) {
          frameRate = num / den;
        }
      } else if (streamInfo && streamInfo.avg_frame_rate) {
        const [num, den] = streamInfo.avg_frame_rate.split('/').map(Number);
        if (den && den > 0) {
          frameRate = num / den;
        }
      }
      
      // Calculate keyframe parameters for smooth HLS playback
      const keyframeParams720 = getHLSKeyframeParams(segmentDuration720, frameRate);
      const keyframeParams480 = getHLSKeyframeParams(segmentDuration480, frameRate);

      // Build FFmpeg commands for both variants
      // 720p variant: use COPY if dimensions match, otherwise libx264
      let cmd720p;
      if (canUseCopy720) {
        console.log(`[${jobId}] [HLS] Using COPY encoder for 720p variant (no scaling needed)`);
        cmd720p = `ffmpeg -i ${escapeShellArg(finalFilePath)} -c:v copy -c:a aac -b:a ${HLS_AUDIO_BITRATE}k -fflags +genpts+igndts -bsf:v ${copyBitstreamFilter} -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration720} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(hlsTempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(hlsTempDir, '720p/playlist.m3u8'))}`;
      } else {
        console.log(`[${jobId}] [HLS] Using libx264 encoder for 720p variant (scaling needed)`);
        cmd720p = `ffmpeg -i ${escapeShellArg(finalFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${highQualityWidth}:${highQualityHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams720} -b:v ${highQualityBitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration720} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(hlsTempDir, '720p/segment%03d.ts'))} ${escapeShellArg(path.join(hlsTempDir, '720p/playlist.m3u8'))}`;
      }
      
      // 480p variant: always use libx264 (always needs scaling)
      console.log(`[${jobId}] [HLS] Using libx264 encoder for 480p variant (scaling needed)`);
      const cmd480p = `ffmpeg -i ${escapeShellArg(finalFilePath)} -c:v ${encoderConfig.encoder} -c:a aac -vf "scale=${variant480Width}:${variant480Height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ${keyframeParams480} -b:v ${variant480Bitrate}k -b:a ${HLS_AUDIO_BITRATE}k${softwareParams ? ` ${softwareParams}` : ''} -fflags +genpts+igndts -bsf:v h264_mp4toannexb -avoid_negative_ts make_zero -f hls -hls_time ${segmentDuration480} -hls_list_size 0 -hls_playlist_type vod -start_number 0 -hls_segment_filename ${escapeShellArg(path.join(hlsTempDir, '480p/segment%03d.ts'))} ${escapeShellArg(path.join(hlsTempDir, '480p/playlist.m3u8'))}`;

      const commands = [cmd720p, cmd480p];

      // Execute HLS conversion commands (sequential)
      normalizeJobs.set(jobId, {
        status: 'processing',
        progress: 60,
        message: 'Converting to dual-variant HLS...',
        startTime: normalizeJobs.get(jobId).startTime
      });

      console.log(`[${jobId}] [HLS] Executing dual-variant HLS conversion...`);
      console.log(`[${jobId}] [FFMPEG] HLS command (720p): ${commands[0]}`);
      await execAsync(commands[0]);
      console.log(`[${jobId}] [FFMPEG] HLS command (480p): ${commands[1]}`);
      await execAsync(commands[1]);
      
      // Create master playlist
      const bandwidth720 = highQualityBitrate * 1000 + HLS_AUDIO_BITRATE_BPS; // video + audio
      const bandwidth480 = variant480Bitrate * 1000 + HLS_AUDIO_BITRATE_BPS;
      
      const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth720},RESOLUTION=${highQualityWidth}x${highQualityHeight}
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth480},RESOLUTION=${variant480Width}x${variant480Height}
480p/playlist.m3u8`;
      
      fs.writeFileSync(path.join(hlsTempDir, 'master.m3u8'), masterPlaylist);
      
      console.log(`[${jobId}] [SUCCESS] Dual-variant HLS conversion completed`);

      // Store HLS bundle in content-addressed storage
      normalizeJobs.set(jobId, {
        status: 'processing',
        progress: 80,
        message: 'Storing HLS stream...',
        startTime: normalizeJobs.get(jobId).startTime
      });

      const escapedHlsPath = escapeShellArg(hlsTempDir);
      const cidOutput = await executeLeitherCommand(`ipfs add ${escapedHlsPath}`, jobId, 6 * 60 * 60 * 1000); // 6 hours for large HLS content

      // Extract CID from output
      const trimmedOutput = cidOutput.trim();
      const ipfsAddOkMatch = trimmedOutput.match(/ipfs\s+add\s+ok\s+(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/i);
      if (ipfsAddOkMatch) {
        cid = ipfsAddOkMatch[1];
      } else {
        const cidMatch = trimmedOutput.match(/(Qm[a-zA-Z0-9]{44}|baf[a-z0-9]{56,})/);
        if (cidMatch) {
          cid = cidMatch[1];
        }
      }

      if (!cid) {
        throw new Error('Failed to extract CID from IPFS add output for HLS content');
      }

      console.log(`[${jobId}] [SUCCESS] HLS content uploaded to IPFS, CID: ${cid}`);
      mediaType = 'hls_video';
      outputSize = finalFileSize;
    }
    
    // Cleanup temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      activeTempDirs.delete(tempDir);
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`[${jobId}] [CLEANUP] Temp directory removed: ${tempDir}`);
      } catch (cleanupError) {
        console.warn(`[${jobId}] [CLEANUP] Failed to remove temp directory: ${cleanupError.message}`);
      }
    }
    
    return { cid, mediaType, size: outputSize, aspectRatio: normalizedAspectRatio };
    
  } catch (error) {
    console.error(`[${jobId}] [ERROR] Video normalization failed:`, error);
    
    // Cleanup on error
    if (tempDir && fs.existsSync(tempDir)) {
      activeTempDirs.delete(tempDir);
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    
    throw error;
  }
}

// Status check endpoint
router.get('/normalize-video/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = normalizeJobs.get(jobId);

  console.log(`[${jobId}] [SERVER-UPLOAD] /normalize-video/status poll:`, job ? {
    status: job.status,
    progress: job.progress,
    message: job.message,
    cid: job.cid,
    mediaType: job.mediaType,
    size: job.size
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
    mediaType: job.mediaType,
    size: job.size,
    aspectRatio: job.aspectRatio,
    startTime: job.startTime,
    endTime: job.endTime
  });
});

// Status check endpoint
router.get('/convert-video/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = processingJobs.get(jobId);
  
  console.log(`[${jobId}] [SERVER-UPLOAD] /convert-video/status poll:`, job ? {
    status: job.status,
    progress: job.progress,
    message: job.message,
    cid: job.cid,
    mediaType: job.mediaType,
    size: job.size
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
    mediaType: job.mediaType,
    size: job.size,
    aspectRatio: job.aspectRatio,
    tempDir: job.tempDir,
    startTime: job.startTime,
    endTime: job.endTime
  });
});

module.exports = router; 
