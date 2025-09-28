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
  const uploadResponse = await fetch(videoUploadUrl, {
    method: 'POST',
    body: formData
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
          const mappedProgress = 25 + Math.round((statusResult.progress * 70) / 100);
          onProgress(mappedProgress);
        }
        
        if (statusResult.status === 'completed') {
          clearInterval(pollInterval);
          if (statusResult.cid) {
            console.log('Video processing completed, CID:', statusResult.cid);
            resolve(statusResult.cid);
          } else {
            reject(new Error('Video processing completed but no CID returned'));
          }
        } else if (statusResult.status === 'failed') {
          clearInterval(pollInterval);
          reject(new Error(statusResult.message || 'Video processing failed'));
        }
        // Continue polling for 'uploading' and 'processing' statuses
        
      } catch (error) {
        console.error('Error checking job status:', error);
        clearInterval(pollInterval);
        reject(new Error(`Failed to check processing status: ${error instanceof Error ? error.message : String(error)}`));
      }
    }, 5000); // Poll every 5 seconds
    
    // Set overall timeout (10 hours)
    setTimeout(() => {
      clearInterval(pollInterval);
      reject(new Error('Video processing timeout after 10 hours'));
    }, 10 * 60 * 60 * 1000);
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