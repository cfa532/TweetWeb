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
      // Calculate new dimensions to maintain aspect ratio
      const maxSize = 2 * 1024 * 1024; // 2MB target
      let { width, height } = img;
      
      // Start with original size and reduce quality until under 2MB
      let quality = 0.9;
      
      const compressWithQuality = () => {
        canvas.width = width;
        canvas.height = height;
        ctx?.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          if (blob) {
            if (blob.size <= maxSize || quality <= 0.1) {
              // Create a new File object with the compressed data
              const compressedFile = new File([blob], file.name, {
                type: file.type,
                lastModified: file.lastModified
              });
              resolve(compressedFile);
            } else {
              // Reduce quality and try again
              quality -= 0.1;
              width = Math.floor(width * 0.9);
              height = Math.floor(height * 0.9);
              compressWithQuality();
            }
          } else {
            reject(new Error('Failed to compress image'));
          }
        }, file.type, quality);
      };
      
      compressWithQuality();
    };
    
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
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
  
  // Step 1: Start the upload and get job ID
  try {
    const uploadResponse = await fetch(videoUploadUrl, {
      method: 'POST',
      body: formData,
      // Add timeout and keep-alive for large files
      signal: AbortSignal.timeout(10 * 60 * 1000), // 10 minute timeout for large files
      headers: {
        'Connection': 'keep-alive'
      }
    });
    
    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }
    
    const uploadResult = await uploadResponse.json();
    if (!uploadResult.success || !uploadResult.jobId) {
      throw new Error(uploadResult.message || 'Failed to start video processing');
    }
    
    const jobId = uploadResult.jobId;
    console.log('Video upload started, job ID:', jobId);
    
    // Show initial progress
    if (onProgress) {
      onProgress(25); // Show 25% for upload completion
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
          
          // Update progress if callback provided (map job progress to 25-95% range)
          if (onProgress && statusResult.progress) {
            const mappedProgress = Math.floor(25 + (statusResult.progress * 0.7)); // Map 0-100% to 25-95%
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
      }, 2000); // Poll every 2 seconds
      
      // Set a maximum timeout of 2 hours
      setTimeout(() => {
        clearInterval(pollInterval);
        reject(new Error('Video processing timeout after 2 hours'));
      }, 2 * 60 * 60 * 1000);
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
      { name: 'HTML5VideoElement', fn: () => tryHTML5VideoElement(file) },
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

// Method 1: HTML5 Video Element (original method)
async function tryHTML5VideoElement(file: File): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      window.URL.revokeObjectURL(video.src);
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve(video.videoWidth / video.videoHeight);
      } else {
        reject(new Error('Invalid video dimensions'));
      }
    };

    video.onerror = () => {
      window.URL.revokeObjectURL(video.src);
      reject(new Error('Video element failed to load'));
    };

    video.src = URL.createObjectURL(file);
  });
}

// Method 2: Analyze file header for common video formats
async function tryFileHeaderAnalysis(file: File): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Check for QuickTime/MOV format (starts with specific atoms)
        if (isQuickTimeFile(uint8Array)) {
          const aspectRatio = parseQuickTimeDimensions(uint8Array);
          if (aspectRatio && aspectRatio > 0) {
            resolve(aspectRatio);
            return;
          }
        }
        
        // Check for MP4 format
        if (isMP4File(uint8Array)) {
          const aspectRatio = parseMP4Dimensions(uint8Array);
          if (aspectRatio && aspectRatio > 0) {
            resolve(aspectRatio);
            return;
          }
        }
        
        reject(new Error('No valid dimensions found in file header'));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsArrayBuffer(file.slice(0, 1024 * 1024)); // Read first 1MB
  });
}

// Method 3: Analyze filename for common aspect ratios
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

// Method 4: Analyze file extension and MIME type for hints
async function tryFileExtensionAnalysis(file: File): Promise<number> {
  const fileName = file.name.toLowerCase();
  const mimeType = file.type.toLowerCase();
  
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

// Helper functions for file format detection
function isQuickTimeFile(uint8Array: Uint8Array): boolean {
  // QuickTime files start with 'ftyp' atom or contain 'moov' atom
  const str = String.fromCharCode.apply(null, Array.from(uint8Array.slice(0, 64)));
  return str.includes('ftyp') || str.includes('moov') || str.includes('mdat');
}

function isMP4File(uint8Array: Uint8Array): boolean {
  // MP4 files start with 'ftyp' atom
  const str = String.fromCharCode.apply(null, Array.from(uint8Array.slice(0, 32)));
  return str.includes('ftyp') && (str.includes('mp41') || str.includes('mp42') || str.includes('isom'));
}

function parseQuickTimeDimensions(uint8Array: Uint8Array): number | null {
  console.log(`[ASPECT-RATIO] Analyzing QuickTime file header (${uint8Array.length} bytes)`);
  
  // Look for common video dimensions in the binary data
  const commonDimensions = [
    // 4:3 aspect ratio
    { width: 640, height: 480 },   // VGA
    { width: 800, height: 600 },   // SVGA
    { width: 1024, height: 768 },  // XGA
    { width: 1152, height: 864 },  // XGA+
    { width: 1280, height: 960 },  // SXGA-
    { width: 1400, height: 1050 }, // SXGA+
    { width: 1600, height: 1200 }, // UXGA
    
    // 3:2 aspect ratio
    { width: 720, height: 480 },   // NTSC DVD
    { width: 1440, height: 960 },  // 3:2 HD
    { width: 1920, height: 1280 }, // 3:2 Full HD
    
    // 16:9 aspect ratio
    { width: 1920, height: 1080 }, // Full HD
    { width: 1280, height: 720 },  // HD
    { width: 3840, height: 2160 }, // 4K
    { width: 2560, height: 1440 }, // QHD
    { width: 1366, height: 768 },  // Common laptop
    
    // 16:10 aspect ratio
    { width: 1920, height: 1200 }, // WUXGA
    { width: 2560, height: 1600 }, // WQXGA
    
    // Portrait orientations
    { width: 1080, height: 1920 }, // Portrait HD
    { width: 720, height: 1280 },  // Portrait HD
    { width: 480, height: 640 },   // Portrait VGA
  ];
  
  for (const dim of commonDimensions) {
    if (containsDimension(uint8Array, dim.width, dim.height)) {
      const ratio = dim.width / dim.height;
      console.log(`[ASPECT-RATIO] Found dimensions ${dim.width}x${dim.height} = ${ratio.toFixed(3)} (${getAspectRatioName(ratio)})`);
      return ratio;
    }
  }
  
  console.log('[ASPECT-RATIO] No common dimensions found in binary data');
  return null;
}

function parseMP4Dimensions(uint8Array: Uint8Array): number | null {
  // Similar to QuickTime parsing, look for dimension patterns
  return parseQuickTimeDimensions(uint8Array);
}

function containsDimension(uint8Array: Uint8Array, width: number, height: number): boolean {
  // Convert dimensions to little-endian bytes and search for them
  const widthBytes = new Uint8Array(new Uint32Array([width]).buffer);
  const heightBytes = new Uint8Array(new Uint32Array([height]).buffer);
  
  // Search for width followed by height (or vice versa) in the binary data
  for (let i = 0; i < uint8Array.length - 8; i++) {
    // Check for width then height
    if (uint8Array[i] === widthBytes[0] && uint8Array[i+1] === widthBytes[1] &&
        uint8Array[i+2] === widthBytes[2] && uint8Array[i+3] === widthBytes[3] &&
        uint8Array[i+4] === heightBytes[0] && uint8Array[i+5] === heightBytes[1] &&
        uint8Array[i+6] === heightBytes[2] && uint8Array[i+7] === heightBytes[3]) {
      return true;
    }
    // Check for height then width
    if (uint8Array[i] === heightBytes[0] && uint8Array[i+1] === heightBytes[1] &&
        uint8Array[i+2] === heightBytes[2] && uint8Array[i+3] === heightBytes[3] &&
        uint8Array[i+4] === widthBytes[0] && uint8Array[i+5] === widthBytes[1] &&
        uint8Array[i+6] === widthBytes[2] && uint8Array[i+7] === widthBytes[3]) {
      return true;
    }
  }
  
  return false;
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

/**
 * Determines the media type of a file based on its MIME type and filename
 * @param mimeType The MIME type of the file
 * @param filename Optional filename to check extension as fallback
 * @returns string The media type ('Image', 'Video', 'Audio', or 'Unknown')
 */
export function getMediaType(mimeType: string, filename?: string): string {
  const lowerMimeType = mimeType.toLowerCase();
  if (lowerMimeType.startsWith('image/')) return 'Image';
  if (lowerMimeType.startsWith('video/')) return 'Video';
  if (lowerMimeType.startsWith('audio/')) return 'Audio';
  
  // Fallback to file extension if MIME type is not recognized
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop();
    if (['mkv', 'avi', 'mp4', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ogv'].includes(ext || '')) {
      return 'Video';
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff'].includes(ext || '')) {
      return 'Image';
    }
    if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'wma'].includes(ext || '')) {
      return 'Audio';
    }
  }
  
  return 'Unknown';
}
