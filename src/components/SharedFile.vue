<script setup lang='ts'>
import { ref, computed, onMounted, reactive } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { useTweetStore } from '@/stores';

// Constants
const FILE_SIZE_THRESHOLD = 50 * 1024 * 1024; // 50MB - use arrayBuffer for files smaller than this
const STREAMABLE_TYPES = ['mp4', 'mp3', 'wav', 'ogg', 'webm', 'pdf'];
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

// State management
const route = useRoute();
const fileId = route.params.mid;
const tweetStore = useTweetStore();
const loading = ref(true);
const error = ref<string | null>(null);
const sharedFile = ref<FileSystemItem | null>(null);
const directoryContents = ref<FileSystemItem[]>([]);
const currentPath = ref('');
const parentPath = ref<string | null>(null);
const directoryHistory = ref<string[]>([]);
const rootPath = ref('');
const retryCount = ref(0);
const rootDirectoryName = ref('Root');

// Progress tracking
const progress = reactive({
  show: false,
  value: 0,
  operation: '',
  speed: '0 KB/s',
  eta: ''
});

// Cache for directory contents
const directoryCache = new Map<string, { contents: FileSystemItem[], timestamp: number, currentPath: string, parentPath: string | null }>();

// Computed properties
const isSingleFileShare = computed(() => 
  sharedFile.value && !sharedFile.value.isDirectory
);

const pathParts = computed(() => {
  if (!currentPath.value) return [];
  const relativePath = currentPath.value.replace(rootPath.value, '');
  return relativePath.split('/').filter(Boolean);
});

const filteredDirectoryContents = computed(() => 
  directoryContents.value.filter(item => 
    !item.name.startsWith('.') && !item.name.startsWith('$')
  )
);

// Utility functions
const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString();
};

const getFileExtension = (filename: string) => {
  return filename.split('.').pop()?.toLowerCase() || '';
};

const formatSpeed = (bytesPerSecond: number) => {
  return formatFileSize(bytesPerSecond) + '/s';
};

const formatETA = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return 'calculating...';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

// File handling functions
const processFileWithProgress = async (url: string, options: { 
  onProgress: (progress: number, speed: string, eta: string) => void, 
  useStreaming?: boolean,
  fileSize?: number
}) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Network response was not ok');
  
  const contentLength = options.fileSize || Number(response.headers.get('Content-Length')) || 0;
  
  // For smaller files or when streaming isn't needed, use arrayBuffer for better performance
  if (!options.useStreaming && contentLength < FILE_SIZE_THRESHOLD) {
    const startTime = Date.now();
    const buffer = await response.arrayBuffer();
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const speed = elapsedSeconds > 0 ? contentLength / elapsedSeconds : 0;
    
    options.onProgress(100, formatSpeed(speed), '0s');
    return new Blob([buffer]);
  }
  
  // For larger files, use streaming
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Failed to get reader from response');
  
  let receivedLength = 0;
  let startTime = Date.now();
  let lastUpdateTime = startTime;
  let lastReceivedLength = 0;
  let speedSamples: number[] = [];
  
  const readableStream = new ReadableStream({
    start(controller) {
      function pump(): any {
        return reader?.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          
          controller.enqueue(value);
          receivedLength += value.length;
          
          // Update progress and speed every ~500ms
          const now = Date.now();
          const timeSinceLastUpdate = (now - lastUpdateTime) / 1000;
          
          if (timeSinceLastUpdate >= 0.5 || done) {
            const overallElapsed = (now - startTime) / 1000;
            const chunkSize = receivedLength - lastReceivedLength;
            const instantSpeed = chunkSize / timeSinceLastUpdate;
            
            // Add to speed samples (keep last 5 samples for smoothing)
            speedSamples.push(instantSpeed);
            if (speedSamples.length > 5) speedSamples.shift();
            
            // Calculate average speed
            const avgSpeed = speedSamples.reduce((sum, s) => sum + s, 0) / speedSamples.length;
            
            // Calculate ETA
            const remainingBytes = contentLength - receivedLength;
            const eta = avgSpeed > 0 ? remainingBytes / avgSpeed : Infinity;
            
            // Update progress
            if (contentLength > 0) {
              const progressPercent = Math.round((receivedLength / contentLength) * 100);
              options.onProgress(
                progressPercent, 
                formatSpeed(avgSpeed),
                formatETA(eta)
              );
            }
            
            lastUpdateTime = now;
            lastReceivedLength = receivedLength;
          }
          
          return pump();
        });
      }
      
      return pump();
    }
  });
  
  const streamResponse = new Response(readableStream);
  return streamResponse.blob();
};

const downloadFile = async (file: FileSystemItem) => {
  try {
    progress.show = true;
    progress.operation = 'Downloading';
    progress.value = 0;
    progress.speed = 'calculating...';
    progress.eta = 'calculating...';
    
    const blob = await processFileWithProgress(file.url, {
      fileSize: file.size,
      onProgress: (value, speed, eta) => {
        progress.value = value;
        progress.speed = speed;
        progress.eta = eta;
      }
    });
    
    // Create download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    // Clean up
    setTimeout(() => {
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
      progress.show = false;
    }, 100);
  } catch (error) {
    console.error('Error downloading file:', error);
    alert('Failed to download file. Please try again.');
    progress.show = false;
  }
};

const viewFile = async (file: FileSystemItem) => {
  try {
    const fileExt = getFileExtension(file.name);
    const isStreamable = STREAMABLE_TYPES.includes(fileExt);
    
    // For large files, use direct streaming
    if (file.size > FILE_SIZE_THRESHOLD && isStreamable) {
      const newTab = window.open('about:blank', '_blank');
      if (newTab) {
        if (fileExt === 'pdf') {
          newTab.location.href = file.url;
        } else if (['mp4', 'webm'].includes(fileExt)) {
          newTab.document.write(`
            <html>
              <head>
                <title>Viewing: ${file.name}</title>
                <style>
                  body { margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f0f0; }
                  .content { max-width: 100%; max-height: 100%; }
                </style>
              </head>
              <body>
                <video controls autoplay class='content'>
                  <source src='${file.url}' type='video/${fileExt}'>
                  Your browser does not support the video tag.
                </video>
              </body>
            </html>
          `);
        } else if (['mp3', 'wav', 'ogg'].includes(fileExt)) {
          newTab.document.write(`
            <html>
              <head>
                <title>Viewing: ${file.name}</title>
                <style>
                  body { margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f0f0; }
                  .content { max-width: 100%; max-height: 100%; }
                </style>
              </head>
              <body>
                <audio controls autoplay class='content'>
                  <source src='${file.url}' type='audio/${fileExt}'>
                  Your browser does not support the audio tag.
                </audio>
              </body>
            </html>
          `);
        } else {
          newTab.location.href = file.url;
        }
      }
      return;
    }
    
    // For smaller files or non-streamable types, use the existing progress-based loading
    progress.show = true;
    progress.operation = 'Loading';
    progress.value = 0;
    progress.speed = 'calculating...';
    progress.eta = 'calculating...';
    
    const blob = await processFileWithProgress(file.url, {
      fileSize: file.size,
      onProgress: (value, speed, eta) => {
        progress.value = value;
        progress.speed = speed;
        progress.eta = eta;
      },
      useStreaming: isStreamable
    });
    
    const blobUrl = URL.createObjectURL(blob);
    
    // Open in a new tab with appropriate handling
    const newTab = window.open('about:blank', '_blank');
    if (newTab) {
      if (fileExt === 'pdf') {
        newTab.location.href = blobUrl;
      } else if (['mp4', 'webm'].includes(fileExt)) {
        newTab.document.write(`
          <html>
            <head>
              <title>Viewing: ${file.name}</title>
              <style>
                body { margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f0f0; }
                .content { max-width: 100%; max-height: 100%; }
              </style>
            </head>
            <body>
              <video controls autoplay class='content'>
                <source src='${blobUrl}' type='video/${fileExt}'>
                Your browser does not support the video tag.
              </video>
            </body>
          </html>
        `);
      } else if (['mp3', 'wav', 'ogg'].includes(fileExt)) {
        newTab.document.write(`
          <html>
            <head>
              <title>Viewing: ${file.name}</title>
              <style>
                body { margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f0f0; }
                .content { max-width: 100%; max-height: 100%; }
              </style>
            </head>
            <body>
              <audio controls autoplay class='content'>
                <source src='${blobUrl}' type='audio/${fileExt}'>
                Your browser does not support the audio tag.
              </audio>
            </body>
          </html>
        `);
      } else {
        newTab.location.href = blobUrl;
      }
    }
    
    progress.show = false;
  } catch (error) {
    console.error('Error viewing file:', error);
    alert('Failed to view file. Please try again.');
    progress.show = false;
  }
};

// Directory navigation functions
const fetchDirectoryContents = async (path: string, baseUrl: string) => {
  try {
    loading.value = true;
    
    // Ensure we don't navigate above the root path
    if (!path.startsWith(rootPath.value)) {
      path = rootPath.value;
    }
    
    // Check cache first (valid for 5 minutes)
    const cacheKey = `${baseUrl}:${path}`;
    const cachedData = directoryCache.get(cacheKey);
    const now = Date.now();
    
    if (cachedData && (now - cachedData.timestamp < 5 * 60 * 1000)) {
      directoryContents.value = cachedData.contents;
      currentPath.value = cachedData.currentPath;
      parentPath.value = cachedData.currentPath !== rootPath.value ? cachedData.parentPath : null;
      
      // Add to history if needed
      if (directoryHistory.value[directoryHistory.value.length - 1] !== path) {
        directoryHistory.value.push(path);
      }
      
      retryCount.value = 0;
      loading.value = false;
      return;
    }
    
    // Make API request if not cached
    const response = await axios.get(`${baseUrl}/netd`, {
      params: { path }
    });
    
    const data = response.data;
    directoryContents.value = data.files || [];
    currentPath.value = data.currentPath || '';
    parentPath.value = currentPath.value !== rootPath.value ? data.parentPath : null;
    
    // Cache the results
    directoryCache.set(cacheKey, {
      contents: directoryContents.value,
      currentPath: currentPath.value,
      parentPath: data.parentPath,
      timestamp: now
    });
    
    // Add to history if needed
    if (directoryHistory.value[directoryHistory.value.length - 1] !== path) {
      directoryHistory.value.push(path);
    }
    
    retryCount.value = 0;
  } catch (err: any) {
    console.error('Failed to load directory contents:', err);
    error.value = err.message || 'Failed to load directory contents';
    
    // Retry logic
    if (retryCount.value < MAX_RETRIES) {
      retryCount.value++;
      console.log(`Retrying (${retryCount.value}/${MAX_RETRIES}) in ${RETRY_DELAY/1000} seconds...`);
      setTimeout(() => {
        fetchDirectoryContents(path, baseUrl);
      }, RETRY_DELAY);
    }
  } finally {
    loading.value = false;
  }
};

const navigateTo = (path: string) => {
  if (sharedFile.value) {
    // If path is empty, navigate to root
    if (!path) {
      fetchDirectoryContents(rootPath.value, sharedFile.value.url);
      return;
    }
    
    // Otherwise, navigate to the specified path
    const fullPath = rootPath.value + (path ? '/' + path : '');
    fetchDirectoryContents(fullPath, sharedFile.value.url);
  }
};

const navigateToParent = () => {
  if (parentPath.value !== null && sharedFile.value && currentPath.value !== rootPath.value) {
    fetchDirectoryContents(parentPath.value, sharedFile.value.url);
    // Remove the last item from history
    directoryHistory.value.pop();
  }
};

// Load shared file with retry logic
const loadSharedFile = async () => {
  try {
    loading.value = true;
    const file = await tweetStore.getSharedFile(fileId as MimeiId);
    
    if (file) {
      sharedFile.value = {
        ...file,
        url: file.url,
      };
      
      if (file.isDirectory) {
        rootPath.value = file.path;
        rootDirectoryName.value = file.name;
        directoryHistory.value = [rootPath.value];
        await fetchDirectoryContents(rootPath.value, file.url);
      } else {
        rootPath.value = file.path.substring(0, file.path.lastIndexOf('/'));
        currentPath.value = rootPath.value;
        directoryHistory.value = [rootPath.value];
        
        const pathParts = rootPath.value.split('/');
        rootDirectoryName.value = pathParts[pathParts.length - 1] || 'Root';
        
        file.url = `${file.url}/netd/${encodeURIComponent(file.path)}`;
        directoryContents.value = [file];
      }
      
      retryCount.value = 0;
    } else {
      error.value = 'File not found.';
      
      if (retryCount.value < MAX_RETRIES) {
        retryCount.value++;
        console.log(`Retrying (${retryCount.value}/${MAX_RETRIES}) in ${RETRY_DELAY/1000} seconds...`);
        setTimeout(loadSharedFile, RETRY_DELAY);
      }
    }
  } catch (err: any) {
    console.error('Failed to load shared file:', err);
    error.value = err.message || 'Failed to load shared file';
    
    if (retryCount.value < MAX_RETRIES) {
      retryCount.value++;
      console.log(`Retrying (${retryCount.value}/${MAX_RETRIES}) in ${RETRY_DELAY/1000} seconds...`);
      setTimeout(loadSharedFile, RETRY_DELAY);
    }
  } finally {
    loading.value = false;
  }
};

// Load initial directory on component mount
onMounted(() => {
  loadSharedFile();
});
</script>

<template>
  <div class='netdisk-container'>
    <!-- Breadcrumb navigation - only show if it's a directory share -->
    <div v-if='!isSingleFileShare' class='breadcrumb'>
      <span @click='navigateTo("")' class='breadcrumb-link'>{{ rootDirectoryName }}</span>
      <template v-for='(part, index) in pathParts' :key='index'>
        / <span @click='navigateTo(pathParts.slice(0, index + 1).join("/"))' class='breadcrumb-link'>{{ part }}</span>
      </template>
    </div>

    <!-- Progress bar for file operations -->
    <div v-if='progress.show' class='progress-container'>
      <div class='progress-label'>
        {{ progress.operation }} file: {{ progress.value }}% 
        <span class='progress-details'>
          ({{ progress.speed }} • {{ progress.eta }} remaining)
        </span>
      </div>
      <div class='progress-bar'>
        <div class='progress-bar-fill' :style='{ width: `${progress.value}%` }'></div>
      </div>
    </div>

    <!-- Loading indicator -->
    <div v-if='loading' class='loading'>
      <div class='loading-spinner'></div>
      <p>Loading... {{ retryCount > 0 ? `(Retry ${retryCount}/${MAX_RETRIES})` : '' }}</p>
    </div>

    <!-- Error message -->
    <div v-if='error && retryCount >= MAX_RETRIES' class='error'>
      {{ error }}
    </div>

    <!-- File listing -->
    <table v-if='!loading && !error && filteredDirectoryContents.length > 0' class='file-list'>
      <thead>
        <tr>
          <th>Name</th>
          <th>Size</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <!-- Parent directory link - only show if not at root and not a single file share -->
        <tr v-if='parentPath !== null && currentPath !== rootPath && !isSingleFileShare'>
          <td>
            <div @click='navigateToParent' class='file-link'>
              <span class='folder-icon'>📁</span>
              <span class='file-name'>..</span>
            </div>
          </td>
          <td></td>
          <td></td>
        </tr>

        <!-- File/directory entries -->
        <tr v-for='item in filteredDirectoryContents' :key='item.path'>
          <td>
            <div @click='item.isDirectory ? navigateTo(item.path.replace(rootPath, "").replace(/^\//, "")) : viewFile(item)' class='file-link'>
              <span :class='item.isDirectory ? "folder-icon" : "file-icon"'>
                {{ item.isDirectory ? '📁' : '📄' }}
              </span>
              <span class='file-name'>{{ item.name }}</span>
            </div>
          </td>
          <td class='file-size'>{{ item.isDirectory ? '-' : formatFileSize(item.size) }}</td>
          <td class='file-actions'>
            <template v-if='!item.isDirectory'>
              <button @click.stop='viewFile(item)' class='action-button'>
                <span class='play-icon'>▶</span>
              </button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- No files message -->
    <div v-if='!loading && !error && filteredDirectoryContents.length === 0' class='no-files'>
      This directory is empty.
    </div>
  </div>
</template>

<style scoped>
/* You can add these styles to your existing CSS */
.progress-details {
  font-size: 0.9em;
  color: #666;
  margin-left: 10px;
}
</style>

<style scoped>
.netdisk-container {
  font-family: Arial, sans-serif;
  margin: 0;
  padding: 20px;
  color: #333;
  max-width: 1200px;
  margin: 0 auto;
}

h1 {
  margin-top: 0;
  border-bottom: 1px solid #eee;
  padding-bottom: 10px;
  color: #2c3e50;
}

.breadcrumb {
  margin-bottom: 20px;
  background-color: #f8f9fa;
  padding: 8px 15px;
  border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.breadcrumb-link {
  color: #007bff;
  text-decoration: none;
  cursor: pointer;
}

.breadcrumb-link:hover {
  text-decoration: underline;
}

/* Progress bar styles */
.progress-container {
  margin: 15px 0;
  padding: 10px;
  background-color: #f8f9fa;
  border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.progress-label {
  margin-bottom: 5px;
  font-weight: 500;
}

.progress-bar {
  height: 20px;
  background-color: #e9ecef;
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background-color: #007bff;
  transition: width 0.3s ease;
}

.file-list {
  width: 100%;
  border-collapse: collapse;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  overflow: hidden;
}

.file-list th,
.file-list td {
  padding: 12px 15px;
  text-align: left;
  border-bottom: 1px solid #ddd;
}

.file-list th {
  background-color: #f8f9fa;
  font-weight: bold;
}

.file-list tr:hover {
  background-color: #f5f5f5;
}

.file-link {
  cursor: pointer;
  display: flex;
  align-items: center;
}

.folder-icon,
.file-icon {
  margin-right: 10px;
}

.folder-icon {
  color: #ffc107;
}

.file-icon {
  color: #6c757d;
}

.file-name {
  font-weight: 500;
}

.file-size,
.file-date {
  color: #6c757d;
  white-space: nowrap;
}

.file-actions {
  white-space: nowrap;
}

.play-icon {
  font-size: 14px;
  color: #28a745;
}

.action-button {
  margin-right: 8px;
  padding: 6px 12px;
  background-color: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
}

.action-button:hover {
  background-color: #e9ecef;
  border-color: #ced4da;
}

.loading,
.error,
.no-files {
  padding: 20px;
  text-align: center;
  background-color: white;
  border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  margin-top: 20px;
}

.loading {
  color: #007bff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.loading-spinner {
  border: 4px solid #f3f3f3;
  border-top: 4px solid #007bff;
  border-radius: 50%;
  width: 30px;
  height: 30px;
  animation: spin 1s linear infinite;
  margin-bottom: 10px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.error {
  color: #dc3545;
}

.no-files {
  color: #6c757d;
  font-style: italic;
}

@media (max-width: 768px) {
  .file-date {
    display: none;
  }
  
  .file-actions {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  
  .action-button {
    margin-right: 0;
    margin-bottom: 5px;
  }
}
</style>