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
 * Uploads a large video file in chunks for better reliability
 * @param file The video file to upload
 * @param baseUrl The base URL (with port) to construct the endpoint URL
 * @param cloudDrivePort The cloud drive port to use for the endpoint
 * @param onProgress Optional progress callback function
 * @param chunkSize Size of each chunk in bytes (default: 10MB)
 * @param maxRetries Maximum number of retries for failed chunks (default: 3)
 * @returns Promise<string> The CID of the uploaded video
 */
export async function uploadVideoChunked(
  file: File,
  baseUrl: string,
  cloudDrivePort: string,
  onProgress?: (progress: number) => void,
  chunkSize: number = 10 * 1024 * 1024, // 10MB chunks
  maxRetries: number = 3
): Promise<string> {
  const url = new URL(baseUrl);
  const videoUploadUrl = `http://${url.hostname}:${cloudDrivePort}/convert-video-chunked`;
  
  console.log('Uploading large video in chunks to:', videoUploadUrl, 'File size:', file.size);
  
  const totalChunks = Math.ceil(file.size / chunkSize);
  let uploadedChunks = 0;
  
  // First, initiate the upload session
  const initResponse = await fetch(`${videoUploadUrl}/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: file.name,
      filesize: file.size,
      contentType: file.type,
      totalChunks: totalChunks
    })
  });
  
  if (!initResponse.ok) {
    throw new Error(`Failed to initiate upload: ${initResponse.status}`);
  }
  
  const initResult = await initResponse.json();
  if (!initResult.success) {
    throw new Error(initResult.message || 'Failed to initiate upload');
  }
  
  const uploadId = initResult.uploadId;
  
  // Helper function to upload a single chunk with retry logic
  const uploadChunkWithRetry = async (chunkIndex: number, retryCount: number = 0): Promise<void> => {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);
    
    const formData = new FormData();
    formData.append('chunk', chunk);
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunkIndex.toString());
    formData.append('totalChunks', totalChunks.toString());
    
    try {
      const chunkResponse = await fetch(`${videoUploadUrl}/chunk`, {
        method: 'POST',
        body: formData
      });
      
      if (!chunkResponse.ok) {
        throw new Error(`HTTP ${chunkResponse.status}: ${chunkResponse.statusText}`);
      }
      
      const chunkResult = await chunkResponse.json();
      if (!chunkResult.success) {
        throw new Error(chunkResult.message || `Chunk ${chunkIndex} upload failed`);
      }
      
      uploadedChunks++;
      if (onProgress) {
        const progress = Math.round((uploadedChunks / totalChunks) * 100);
        onProgress(progress);
      }
      
    } catch (error) {
      if (retryCount < maxRetries) {
        console.warn(`Retrying chunk ${chunkIndex} (attempt ${retryCount + 1}/${maxRetries}):`, error);
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
        return uploadChunkWithRetry(chunkIndex, retryCount + 1);
      } else {
        throw new Error(`Failed to upload chunk ${chunkIndex} after ${maxRetries} retries: ${error}`);
      }
    }
  };
  
  // Upload chunks sequentially to avoid overwhelming the server
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    await uploadChunkWithRetry(chunkIndex);
  }
  
  // Finalize the upload
  const finalizeResponse = await fetch(`${videoUploadUrl}/finalize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uploadId: uploadId
    })
  });
  
  if (!finalizeResponse.ok) {
    throw new Error(`Failed to finalize upload: ${finalizeResponse.status}`);
  }
  
  const finalizeResult = await finalizeResponse.json();
  if (!finalizeResult.success) {
    throw new Error(finalizeResult.message || 'Failed to finalize upload');
  }
  
  return finalizeResult.cid;
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
  noResample: boolean = false
): Promise<string> {
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
  
  console.log('Uploading video to:', videoUploadUrl, 'File size:', file.size, 'noResample:', noResample);
  
  // Create multipart form data
  const formData = new FormData();
  formData.append('videoFile', file);
  formData.append('filename', file.name);
  formData.append('filesize', file.size.toString());
  formData.append('contentType', file.type);
  formData.append('noResample', noResample.toString());
  
  // Use XMLHttpRequest for better progress tracking and multipart support
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    
    // Progress tracking
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });
    
    // Handle response
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result: VideoUploadResponse = JSON.parse(xhr.responseText);
          if (result.success) {
            resolve(result.cid);
          } else {
            reject(new Error(result.message || 'Video upload failed'));
          }
        } catch (error) {
          reject(new Error('Invalid response format'));
        }
      } else {
        reject(new Error(`HTTP error! status: ${xhr.status}`));
      }
    });
    
    // Handle errors
    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'));
    });
    
    xhr.addEventListener('abort', () => {
      reject(new Error('Upload was aborted'));
    });
    
    // Set timeout for large files (24 hours)
    xhr.timeout = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    xhr.addEventListener('timeout', () => {
      reject(new Error('Upload timeout after 24 hours'));
    });
    
    // Open and send request
    xhr.open('POST', videoUploadUrl);
    
    // Set headers for multipart form data
    xhr.setRequestHeader('Accept', 'application/json');
    
    // Send the form data
    xhr.send(formData);
  });
}

/**
 * Gets the aspect ratio of a video file
 * @param file The video file to analyze
 * @returns Promise<number> The aspect ratio (width/height)
 */
export async function getVideoAspectRatio(file: File): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      // Calculate aspect ratio
      const aspectRatio = video.videoWidth / video.videoHeight;
      resolve(aspectRatio);
    };

    video.onerror = () => {
      reject(new Error('Failed to load video metadata'));
    };

    // Set video source
    video.src = URL.createObjectURL(file);
  });
}

/**
 * Determines the media type of a file based on its MIME type
 * @param mimeType The MIME type of the file
 * @returns string The media type ('Image', 'Video', 'Audio', or 'Unknown')
 */
export function getMediaType(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  return 'Unknown';
} 