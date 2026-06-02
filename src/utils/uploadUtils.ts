import { useAlertStore } from '@/stores/alert.store';

export interface VideoUploadResponse {
  success: boolean;
  cid: string;
  message?: string;
}

/**
 * Compresses an image file to under 2MB while maintaining aspect ratio
 * @param file The image file to compress
 * @returns Promise<File> The compressed image file
 */
export async function compressImage(file: File): Promise<File> {
  return new Promise<File>((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      // Match iOS behavior: compress to JPEG at 80% quality
      // This ensures consistent format and quality
      canvas.width = img.width;
      canvas.height = img.height;
      ctx?.drawImage(img, 0, 0, img.width, img.height);
      
      // Always use JPEG format with 80% quality (matches iOS)
      canvas.toBlob((blob) => {
        if (blob) {
          // Change extension to .jpg if it was .png or other format
          const newFileName = file.name.replace(/\.[^.]+$/, '.jpg');
          const compressedFile = new File([blob], newFileName, {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          console.log(`[COMPRESS] ${file.name} (${(file.size / 1024).toFixed(1)}KB) -> ${newFileName} (${(blob.size / 1024).toFixed(1)}KB) at 80% quality`);
          resolve(compressedFile);
        } else {
          reject(new Error('Failed to compress image'));
        }
      }, 'image/jpeg', 0.8);  // 80% quality, matches iOS
    };
    
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}


/**
 * Normalizes a small video file (<50MB) to MP4 format with max 720p resolution
 * Uses the same pattern as uploadVideo - single file upload with status polling
 * @param file The video file to normalize (must be <50MB)
 * @param baseUrl The base URL (with port) to construct the endpoint URL
 * @param cloudDrivePort The cloud drive port to use for the endpoint
 * @param onProgress Optional progress callback function
 * @returns Promise<string> The CID of the normalized video
 */
export async function normalizeVideo(
  file: File,
  baseUrl: string,
  cloudDrivePort: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  // Validate file size (50MB limit)
  const maxFileSize = 50 * 1024 * 1024; // 50MB
  if (file.size > maxFileSize) {
    throw new Error(`File size ${(file.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 50MB for normalization.`);
  }
  
  // Validate baseUrl
  if (!baseUrl || (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://'))) {
    throw new Error(`Invalid baseUrl: ${baseUrl}. Must be a valid HTTP/HTTPS URL.`);
  }
  
  // Extract IP from baseUrl and construct new URL with cloudDrivePort
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error(`Failed to parse baseUrl: ${baseUrl}. Error: ${error}`);
  }
  
  const normalizeVideoUrl = `http://${url.hostname}:${cloudDrivePort}/normalize-video`;
  const statusUrl = `http://${url.hostname}:${cloudDrivePort}/normalize-video/status`;
  
  console.log('Normalizing video:', normalizeVideoUrl, 'File size:', file.size);
  
  // Create multipart form data (same as uploadVideo)
  const formData = new FormData();
  formData.append('videoFile', file);
  formData.append('filename', file.name);
  formData.append('filesize', file.size.toString());
  formData.append('contentType', file.type);
  
  if (onProgress) {
    onProgress(5); // Show initial progress
  }
  
  try {
    // Step 1: Start the upload and get job ID with progress tracking
    console.log(`[NORMALIZE] Sending upload request...`);
    
    // Use XMLHttpRequest for upload progress tracking (same as uploadVideo)
    const uploadResult = await new Promise<any>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      // Track upload progress (5-40% of total progress bar)
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          const uploadProgress = Math.max(5, Math.round(5 + ((event.loaded / event.total) * 35))); // 5-40% for upload
          onProgress(uploadProgress);
        }
      });
      
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            resolve(result);
          } catch (parseError) {
            reject(new Error('Invalid response format'));
          }
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
        }
      });
      
      xhr.addEventListener('error', () => {
        reject(new Error('Network error during upload'));
      });
      
      xhr.addEventListener('timeout', () => {
        reject(new Error('Upload timeout'));
      });
      
      xhr.open('POST', normalizeVideoUrl);
      xhr.timeout = 10 * 60 * 1000; // 10 minute timeout
      xhr.setRequestHeader('Cache-Control', 'no-cache');
      xhr.send(formData);
    });
    
    const jobId = uploadResult.jobId;
    if (!jobId) {
      throw new Error('No jobId returned from server');
    }
    
    console.log(`[NORMALIZE] Upload completed, job ID: ${jobId}`);
    
    // Show upload completion progress (40% of total progress bar)
    if (onProgress) {
      onProgress(40); // Show 40% for upload completion
    }
    
    // Step 2: Poll for completion
    return new Promise<string>((resolve, reject) => {
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`${statusUrl}/${jobId}`);
          if (!statusResponse.ok) {
            throw new Error(`Status check failed: ${statusResponse.status}`);
          }
          
          const statusResult = await statusResponse.json();
          console.log('[NORMALIZE] Job status:', statusResult.status, 'Progress:', statusResult.progress + '%', 'Message:', statusResult.message);
          
          // Update progress if callback provided (map job progress to 40-95% range)
          if (onProgress && statusResult.progress) {
            const mappedProgress = Math.floor(40 + (statusResult.progress * 0.55)); // Map 0-100% to 40-95%
            onProgress(mappedProgress);
          }
          
          if (statusResult.status === 'completed') {
            clearInterval(pollInterval);
            if (onProgress) {
              onProgress(95); // Show 95% for processing completion
            }
            
            if (!statusResult.cid) {
              reject(new Error('No CID returned from completed job'));
              return;
            }
            
            console.log('Video normalization completed, CID:', statusResult.cid);
            resolve(statusResult.cid);
          } else if (statusResult.status === 'failed') {
            clearInterval(pollInterval);
            reject(new Error(statusResult.message || 'Video normalization failed'));
          }
        } catch (error) {
          clearInterval(pollInterval);
          reject(error);
        }
      }, 2000); // Poll every 2 seconds
      
      // Set a maximum timeout of 10 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        reject(new Error('Video normalization timeout after 10 minutes'));
      }, 10 * 60 * 1000);
    });
    
  } catch (error: any) {
    console.error('Video normalization error:', error);
    throw error;
  }
}

/**
 * Uploads a video file to the convert-video endpoint using multipart form data
 * @param file The video file to upload
 * @param baseUrl The base URL (with port) to construct the endpoint URL
 * @param cloudDrivePort The cloud drive port to use for the endpoint
 * @param onProgress Optional progress callback function
 * @param noResample Optional boolean to control whether to resample the video (default: false)
 * @returns Promise<string> The CID of the uploaded video
 */
export async function uploadVideo(
  file: File, 
  baseUrl: string, 
  cloudDrivePort: string,
  onProgress?: (progress: number) => void,
  noResample: boolean = false,
  retryCount: number = 0
): Promise<string> {
  // Validate file size (4GB limit to match backend)
  const maxFileSize = 4 * 1024 * 1024 * 1024; // 4GB
  if (file.size > maxFileSize) {
    throw new Error(`File size ${(file.size / (1024 * 1024)).toFixed(2)}MB exceeds the maximum allowed size of 4GB.`);
  }
  
  // Validate baseUrl
  if (!baseUrl || (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://'))) {
    throw new Error(`Invalid baseUrl: ${baseUrl}. Must be a valid HTTP/HTTPS URL.`);
  }
  
  // Extract IP from baseUrl and construct new URL with cloudDrivePort
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error(`Failed to parse baseUrl: ${baseUrl}. Error: ${error}`);
  }
  
  const videoUploadUrl = `http://${url.hostname}:${cloudDrivePort}/convert-video`;
  const statusUrl = `http://${url.hostname}:${cloudDrivePort}/convert-video/status`;
  
  console.log('Uploading video to:', videoUploadUrl, 'File size:', file.size, 'noResample:', noResample, 'retry:', retryCount);
  
  // Create multipart form data
  const formData = new FormData();
  formData.append('videoFile', file);
  formData.append('filename', file.name);
  formData.append('filesize', file.size.toString());
  formData.append('contentType', file.type);
  formData.append('noResample', noResample.toString());
  
  console.log(`[CLIENT-UPLOAD-TIMING] Starting upload at ${new Date().toISOString()}`);
  const uploadStartTime = Date.now();
  
  // Step 1: Start the upload and get job ID with progress tracking
  try {
    console.log(`[CLIENT-UPLOAD-TIMING] Sending upload request with progress tracking...`);
    
    // Use XMLHttpRequest for upload progress tracking
    const uploadResult = await new Promise<any>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      // Track upload progress (0-40% of total progress bar)
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          const rawPct = event.loaded / event.total;
          const uploadProgress = rawPct > 0 ? Math.max(1, Math.round(rawPct * 40)) : 0;
          console.log(`[UPLOAD-PROGRESS] ${uploadProgress}% (${(event.loaded / 1024 / 1024).toFixed(2)}MB / ${(event.total / 1024 / 1024).toFixed(2)}MB)`);
          onProgress(uploadProgress);
        }
      });
      
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            resolve(result);
          } catch (parseError) {
            reject(new Error('Invalid response format'));
          }
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
        }
      });
      
      xhr.addEventListener('error', () => {
        reject(new Error('Network error during upload'));
      });
      
      xhr.addEventListener('timeout', () => {
        reject(new Error('Upload timeout'));
      });
      
      xhr.open('POST', videoUploadUrl);
      xhr.timeout = 30 * 60 * 1000; // 30 minute timeout for large files
      // Note: Browsers automatically manage the 'Connection' header - we cannot set it
      xhr.setRequestHeader('Cache-Control', 'no-cache');
      xhr.send(formData);
    });
    
    const uploadCompleteTime = Date.now();
    const uploadDuration = uploadCompleteTime - uploadStartTime;
    console.log(`[CLIENT-UPLOAD-TIMING] Upload completed at ${new Date().toISOString()} (${uploadDuration}ms total)`);
    console.log(`[CLIENT-UPLOAD-TIMING] Upload speed: ${(file.size / (uploadDuration / 1000) / 1024 / 1024).toFixed(2)} MB/s`);
    
    if (!uploadResult.success || !uploadResult.jobId) {
      throw new Error(uploadResult.message || 'Failed to start video processing');
    }
    
    const jobId = uploadResult.jobId;
    console.log('Video upload started, job ID:', jobId);
    
    // Show upload completion progress (40% of total progress bar)
    if (onProgress) {
      onProgress(40); // Show 40% for upload completion
    }
    
    // Step 2: Poll for completion
    return new Promise<string>((resolve, reject) => {
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`${statusUrl}/${jobId}`);
          if (!statusResponse.ok) {
            throw new Error(`Status check failed: ${statusResponse.status}`);
          }
          
          const statusResult = await statusResponse.json();
          console.log('Job status:', statusResult.status, 'Progress:', statusResult.progress + '%', 'Message:', statusResult.message);
          
          // Map server progress 0-50% → 40-70% (video processing)
          // and 50-100% → 70-100% (server-side storage step).
          if (onProgress && statusResult.progress) {
            let mappedProgress;
            if (statusResult.progress <= 50) {
              mappedProgress = Math.floor(40 + (statusResult.progress * 0.6));
            } else {
              mappedProgress = Math.floor(70 + ((statusResult.progress - 50) * 0.6));
            }
            onProgress(mappedProgress);
          }
          
          if (statusResult.status === 'completed') {
            clearInterval(pollInterval);
            if (onProgress) {
              onProgress(95); // Show 95% for processing completion
            }
            
            if (!statusResult.cid) {
              reject(new Error('No CID returned from completed job'));
              return;
            }
            
            console.log('Video processing completed, CID:', statusResult.cid);
            resolve(statusResult.cid);
          } else if (statusResult.status === 'failed') {
            clearInterval(pollInterval);
            reject(new Error(statusResult.message || 'Video processing failed'));
          }
        } catch (error) {
          clearInterval(pollInterval);
          reject(error);
        }
      }, 5000); // Poll every 5 seconds for better responsiveness
      
      // Set a maximum timeout of 4 hours for large files
      setTimeout(() => {
        clearInterval(pollInterval);
        reject(new Error('Video processing timeout after 4 hours'));
      }, 4 * 60 * 60 * 1000);
    });
  } catch (error: any) {
    // Log connection errors for debugging
    if (error.name === 'AbortError' || error.message.includes('ERR_CONNECTION_RESET') || error.message.includes('Failed to fetch')) {
      console.error('Network error during upload:', error.message);
    }
    throw error;
  }
}

/**
 * Gets the aspect ratio of a video file
 * @param file The video file to analyze
 * @returns Promise<number> The aspect ratio (width/height)
 */
export async function getVideoAspectRatio(file: File): Promise<number> {
  return new Promise<number>(async (resolve, reject) => {
    console.log(`[ASPECT-RATIO] Starting detection for file: ${file.name} (${file.type})`);
    
    // Try multiple methods to detect aspect ratio
    const methods = [
      { name: 'VideoElement', fn: () => tryVideoElementAnalysis(file) },
      { name: 'FileHeaderAnalysis', fn: () => tryFileHeaderAnalysis(file) },
      { name: 'FileNameAnalysis', fn: () => tryFileNameAnalysis(file) },
      { name: 'FileExtensionAnalysis', fn: () => tryFileExtensionAnalysis(file) }
    ];

    for (const method of methods) {
      try {
        console.log(`[ASPECT-RATIO] Trying method: ${method.name}`);
        const aspectRatio = await method.fn();
        if (aspectRatio && aspectRatio > 0) {
          console.log(`[ASPECT-RATIO] SUCCESS: Detected aspect ratio ${aspectRatio.toFixed(2)} (${getAspectRatioName(aspectRatio)}) using ${method.name}`);
          resolve(aspectRatio);
          return;
        }
      } catch (error) {
        console.warn(`[ASPECT-RATIO] ${method.name} failed:`, error);
      }
    }

    // All methods failed, use default
    console.warn('[ASPECT-RATIO] All detection methods failed, using default 16:9');
    resolve(16/9);
  });
}

function getAspectRatioName(ratio: number): string {
  const tolerance = 0.01;
  if (Math.abs(ratio - (4/3)) < tolerance) return '4:3';
  if (Math.abs(ratio - (16/9)) < tolerance) return '16:9';
  if (Math.abs(ratio - (21/9)) < tolerance) return '21:9';
  if (Math.abs(ratio - (16/10)) < tolerance) return '16:10';
  if (Math.abs(ratio - (3/2)) < tolerance) return '3:2';
  if (Math.abs(ratio - (9/16)) < tolerance) return '9:16 (portrait)';
  if (Math.abs(ratio - 1) < tolerance) return '1:1 (square)';
  return `${ratio.toFixed(3)}:1`;
}

// Method 0: Use browser's video element to get actual dimensions
async function tryVideoElementAnalysis(file: File): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;

    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.src = '';
      if (err) reject(err); else resolve(video.videoWidth / video.videoHeight);
    };

    const timer = setTimeout(() => cleanup(new Error('Video element metadata timeout')), 8000);

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      if (video.videoWidth && video.videoHeight) {
        cleanup();
      } else {
        cleanup(new Error('Video element reported zero dimensions'));
      }
    };
    video.onerror = () => {
      clearTimeout(timer);
      cleanup(new Error('Video element failed to load metadata'));
    };
    video.src = url;
  });
}

// Method 1: Parse MP4/MOV box structure to extract video dimensions
async function tryFileHeaderAnalysis(file: File): Promise<number> {
  // Try the first 1MB (covers faststart-optimized files where moov is at the front)
  const firstChunk = await readFileSlice(file, 0, Math.min(file.size, 1024 * 1024));
  if (isMP4OrQuickTimeData(firstChunk)) {
    const ratio = extractAspectRatioFromMP4Boxes(firstChunk);
    if (ratio) return ratio;

    // moov not in first 1MB — try last 2MB (common for non-faststart files)
    if (file.size > 1024 * 1024) {
      const tailStart = Math.max(0, file.size - 2 * 1024 * 1024);
      const tailChunk = await readFileSlice(file, tailStart, file.size);
      const ratio2 = extractAspectRatioFromMP4Boxes(tailChunk);
      if (ratio2) return ratio2;
    }
  }
  throw new Error('No valid dimensions found in file header');
}

function readFileSlice(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(new Uint8Array(e.target!.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsArrayBuffer(file.slice(start, end));
  });
}

function isMP4OrQuickTimeData(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const type = String.fromCharCode(data[4], data[5], data[6], data[7]);
  return type === 'ftyp' || type === 'moov' || type === 'mdat' || type === 'wide' || type === 'free';
}

function mp4Uint32BE(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset+1] << 16) | (data[offset+2] << 8) | data[offset+3]) >>> 0;
}

function mp4FindBox(data: Uint8Array, start: number, end: number, target: string): { dataStart: number; dataEnd: number } | null {
  const cap = Math.min(end, data.length);
  let offset = start;
  while (offset + 8 <= cap) {
    let size = mp4Uint32BE(data, offset);
    const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > cap) break;
      size = mp4Uint32BE(data, offset + 12); // lower 32 bits of 64-bit size
      headerSize = 16;
    } else if (size === 0) {
      size = cap - offset;
    }
    if (size < headerSize) break;
    if (type === target) return { dataStart: offset + headerSize, dataEnd: Math.min(offset + size, cap) };
    offset += size;
  }
  return null;
}

function mp4ParseTkhd(data: Uint8Array, start: number, end: number): { width: number; height: number } | null {
  if (start + 4 > data.length) return null;
  const version = data[start];
  // version 0: creation(4)+modification(4)+track_id(4)+reserved(4)+duration(4) = 20 bytes
  // version 1: creation(8)+modification(8)+track_id(4)+reserved(4)+duration(8) = 32 bytes
  const varSize = version === 1 ? 32 : 20;
  // After version(1)+flags(3)+varFields: reserved(8)+layer(2)+altGroup(2)+volume(2)+reserved(2) = 16 bytes, then matrix(36)
  const matrixOff = start + 4 + varSize + 16;
  const dimOff = matrixOff + 36;
  if (dimOff + 8 > Math.min(end, data.length)) return null;

  // Width/height are 16.16 fixed-point big-endian; integer part is the upper 2 bytes
  let w = (data[dimOff] << 8) | data[dimOff + 1];
  let h = (data[dimOff + 4] << 8) | data[dimOff + 5];
  if (w <= 0 || h <= 0) return null;

  // Read rotation from the 3×3 matrix (9 × 4-byte 16.16 fixed-point values, big-endian).
  // Matrix layout: [a b u / c d v / tx ty w] where u=v=0, w=0x40000000.
  // Identity:  a=0x00010000, b=0, c=0, d=0x00010000
  // 90° CW:    a=0, b=0x00010000, c=0xFFFF0000, d=0
  // 90° CCW:   a=0, b=0xFFFF0000, c=0x00010000, d=0
  // 180°:      a=0xFFFF0000, b=0, c=0, d=0xFFFF0000
  const ma = mp4Uint32BE(data, matrixOff);      // a  (signed: 0x00010000=1, 0xFFFF0000=-1)
  const mb = mp4Uint32BE(data, matrixOff + 4);  // b
  const isRotated90 = (ma === 0 && mb !== 0);   // a==0 means 90° or 270° rotation
  if (isRotated90) { const tmp = w; w = h; h = tmp; }

  return { width: w, height: h };
}

// Scan for an atom type anywhere in data (robust for mid-file tail chunks)
function findAtomAnywhere(data: Uint8Array, atomType: string): number {
  const b0 = atomType.charCodeAt(0), b1 = atomType.charCodeAt(1);
  const b2 = atomType.charCodeAt(2), b3 = atomType.charCodeAt(3);
  for (let i = 0; i + 8 <= data.length; i++) {
    if (data[i+4] === b0 && data[i+5] === b1 && data[i+6] === b2 && data[i+7] === b3) {
      const size = mp4Uint32BE(data, i);
      if (size >= 8 || size === 1) return i;
    }
  }
  return -1;
}

function extractAspectRatioFromMP4Boxes(data: Uint8Array): number | null {
  // Scan for moov anywhere (handles both faststart head chunk and non-faststart tail chunk)
  const moovOffset = findAtomAnywhere(data, 'moov');
  if (moovOffset < 0) return null;

  let moovSize = mp4Uint32BE(data, moovOffset);
  let moovHeaderSize = 8;
  if (moovSize === 1 && moovOffset + 16 <= data.length) {
    moovSize = mp4Uint32BE(data, moovOffset + 12);
    moovHeaderSize = 16;
  } else if (moovSize === 0) {
    moovSize = data.length - moovOffset;
  }
  const moovDataStart = moovOffset + moovHeaderSize;
  const moovDataEnd = Math.min(moovOffset + moovSize, data.length);

  let offset = moovDataStart;
  let bestRatio: number | null = null;
  let bestPixels = 0;

  while (offset + 8 <= moovDataEnd) {
    let size = mp4Uint32BE(data, offset);
    const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
    if (size === 1 && offset + 16 <= moovDataEnd) size = mp4Uint32BE(data, offset + 12);
    else if (size === 0) size = moovDataEnd - offset;
    if (size < 8) break;

    if (type === 'trak') {
      const tkhdRange = mp4FindBox(data, offset + 8, Math.min(offset + size, moovDataEnd), 'tkhd');
      if (tkhdRange) {
        const dims = mp4ParseTkhd(data, tkhdRange.dataStart, tkhdRange.dataEnd);
        if (dims) {
          const px = dims.width * dims.height;
          if (px > bestPixels) { bestPixels = px; bestRatio = dims.width / dims.height; }
        }
      }
    }
    offset += size;
  }

  if (bestRatio) console.log(`[ASPECT-RATIO] MP4 box parser found ratio ${Math.round(bestRatio * 1000) / 1000} from tkhd`);
  return bestRatio;
}

// Method 2: Analyze filename for common aspect ratios
async function tryFileNameAnalysis(file: File): Promise<number> {
  const fileName = file.name.toLowerCase();
  
  // Common aspect ratio patterns in filenames
  const aspectRatioPatterns = [
    { pattern: /1920x1080|1080p|fhd/, ratio: 16/9 },
    { pattern: /1280x720|720p|hd/, ratio: 16/9 },
    { pattern: /3840x2160|4k|2160p/, ratio: 16/9 },
    { pattern: /2560x1440|1440p|qhd/, ratio: 16/9 },
    { pattern: /1366x768/, ratio: 1366/768 },
    { pattern: /1920x1200/, ratio: 16/10 },
    { pattern: /2560x1600/, ratio: 16/10 },
    { pattern: /1080x1920|portrait/, ratio: 9/16 },
    { pattern: /720x1280/, ratio: 9/16 },
    { pattern: /square|1x1/, ratio: 1/1 },
    { pattern: /4x3|4:3/, ratio: 4/3 },
    { pattern: /3x2|3:2/, ratio: 3/2 },
    { pattern: /16x9|16:9/, ratio: 16/9 },
    { pattern: /21x9|21:9|ultrawide/, ratio: 21/9 }
  ];
  
  for (const { pattern, ratio } of aspectRatioPatterns) {
    if (pattern.test(fileName)) {
      return ratio;
    }
  }
  
  throw new Error('No aspect ratio pattern found in filename');
}

// Method 3: Analyze file extension and MIME type for hints
async function tryFileExtensionAnalysis(file: File): Promise<number> {
  const fileName = file.name.toLowerCase();
  const mimeType = (file.type || '').toLowerCase();
  
  console.log(`[ASPECT-RATIO] Analyzing file extension: ${fileName}, MIME: ${mimeType}`);
  
  // Check for specific file extensions that commonly have 4:3 aspect ratio
  const fourThreeExtensions = ['.mov', '.avi', '.mpg', '.mpeg', '.m4v'];
  const isFourThreeExtension = fourThreeExtensions.some(ext => fileName.endsWith(ext));
  
  // Check MIME types that commonly have 4:3
  const fourThreeMimes = ['video/quicktime', 'video/x-msvideo', 'video/mpeg'];
  const isFourThreeMime = fourThreeMimes.some(mime => mimeType.includes(mime));
  
  // If it's a .mov file or QuickTime MIME type, it's more likely to be 4:3 (especially older videos)
  if (isFourThreeExtension || isFourThreeMime) {
    console.log('[ASPECT-RATIO] Detected 4:3 likely format based on extension/MIME type');
    return 4/3; // 1.333...
  }
  
  // Check for modern formats that are more likely 16:9
  const sixteenNineExtensions = ['.mp4', '.webm', '.mkv'];
  const sixteenNineMimes = ['video/mp4', 'video/webm', 'video/x-matroska'];
  
  const isSixteenNineExtension = sixteenNineExtensions.some(ext => fileName.endsWith(ext));
  const isSixteenNineMime = sixteenNineMimes.some(mime => mimeType.includes(mime));
  
  if (isSixteenNineExtension || isSixteenNineMime) {
    console.log('[ASPECT-RATIO] Detected 16:9 likely format based on extension/MIME type');
    return 16/9; // 1.777...
  }
  
  throw new Error('No aspect ratio hint found in file extension or MIME type');
}


/**
 * Gets the aspect ratio of an image file
 * @param file The image file to analyze
 * @returns Promise<number> The aspect ratio (width/height)
 */
export async function getImageAspectRatio(file: File): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const img = new Image();
    
    img.onload = () => {
      // Calculate aspect ratio
      const aspectRatio = img.width / img.height;
      resolve(aspectRatio);
    };
    
    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };
    
    img.src = URL.createObjectURL(file);
  });
}

import { MEDIA_TYPES } from '@/lib';

/**
 * Determines the media type of a file based on its MIME type and filename
 * @param mimeType The MIME type of the file
 * @param filename Optional filename to check extension as fallback
 * @returns string The media type (lowercase: 'image', 'video', 'audio', or 'unknown')
 */
export function getMediaType(mimeType: string, filename?: string): string {
  const lowerMimeType = mimeType.toLowerCase();
  if (lowerMimeType.startsWith('image/')) return MEDIA_TYPES.IMAGE;
  if (lowerMimeType.startsWith('video/')) return MEDIA_TYPES.VIDEO;
  if (lowerMimeType.startsWith('audio/')) return MEDIA_TYPES.AUDIO;
  
  // Fallback to file extension if MIME type is not recognized
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop();
    if (['mkv', 'avi', 'mp4', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ogv'].includes(ext || '')) {
      return MEDIA_TYPES.VIDEO;
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff'].includes(ext || '')) {
      return MEDIA_TYPES.IMAGE;
    }
    if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'wma'].includes(ext || '')) {
      return MEDIA_TYPES.AUDIO;
    }
  }
  
  return MEDIA_TYPES.UNKNOWN;
}
