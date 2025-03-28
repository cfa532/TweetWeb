<script setup lang='ts'>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { useTweetStore } from '@/stores';

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
const rootPath = ref(''); // Store the root path (shared directory path)
const retryCount = ref(0);
const maxRetries = 2;
const rootDirectoryName = ref('Root'); // Store the name of the shared directory

// Computed property to determine if we're sharing a single file
const isSingleFileShare = computed(() => {
  return sharedFile.value && !sharedFile.value.isDirectory;
});

// Computed property to split the current path into parts for breadcrumb
const pathParts = computed(() => {
  if (!currentPath.value) return [];
  // Only include path parts relative to the root path
  const relativePath = currentPath.value.replace(rootPath.value, '');
  return relativePath.split('/').filter(Boolean);
});

// Computed property to filter out system files
const filteredDirectoryContents = computed(() => {
  return directoryContents.value.filter(item => {
    // Filter out files/folders that start with a dot or dollar sign
    return !item.name.startsWith('.') && !item.name.startsWith('$');
  });
});

// File action functions
const viewFile = async (file: FileSystemItem) => {
  try {
    loading.value = true;
    const response = await fetch(file.url);
    
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    
    // Open the blob URL in a new tab
    window.open(blobUrl, '_blank');
  } catch (error) {
    console.error('Error viewing file:', error);
    alert('Failed to view file. Please try again.');
  } finally {
    loading.value = false;
  }
};

const downloadFile = async (file: FileSystemItem) => {
  try {
    loading.value = true;
    
    // Use the downloadBlob method
    await downloadBlob(file.url, file.name);
    
  } catch (error) {
    console.error('Error downloading file:', error);
    alert('Failed to download file. Please try again.');
  } finally {
    loading.value = false;
  }
};

// Utility function to download blob
const downloadBlob = async (url: string, fileName: string) => {
  console.log("Download", url);
  return fetch(url) // Return the promise from fetch
    .then(response => {
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      return response.blob(); // Convert the response to a Blob
    })
    .then(blob => {
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = fileName; // Use the file's actual name
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    })
    .catch(error => {
      console.error('There was a problem with the fetch operation:', error);
      throw error; // Re-throw to be caught by the calling function
    });
};

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

// Function to fetch directory contents
const fetchDirectoryContents = async (path: string, baseUrl: string) => {
  try {
    loading.value = true;
    // Ensure we don't navigate above the root path
    if (!path.startsWith(rootPath.value)) {
      path = rootPath.value;
    }
    
    // Make sure we're using the correct endpoint format
    const response = await axios.get(`${baseUrl}/netd`, {
      params: { path }
    });
    
    directoryContents.value = response.data.files || [];
    currentPath.value = response.data.currentPath || '';
    
    // Only set parentPath if we're not at the root of the shared directory
    // This prevents navigating above the shared directory
    parentPath.value = currentPath.value !== rootPath.value ? response.data.parentPath : null;
    
    // Add current path to history if it's not already the last item
    if (directoryHistory.value[directoryHistory.value.length - 1] !== path) {
      directoryHistory.value.push(path);
    }
    
    // Reset retry count on successful fetch
    retryCount.value = 0;
  } catch (err: any) {
    console.error('Failed to load directory contents:', err);
    error.value = err.message || 'Failed to load directory contents';
    
    // Retry logic
    if (retryCount.value < maxRetries) {
      retryCount.value++;
      console.log(`Retrying (${retryCount.value}/${maxRetries}) in 5 seconds...`);
      setTimeout(() => {
        fetchDirectoryContents(path, baseUrl);
      }, 5000);
    }
  } finally {
    loading.value = false;
  }
};

// Navigation functions
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

// Function to load shared file with retry logic
const loadSharedFile = async () => {
  try {
    loading.value = true;
    const file = await tweetStore.getSharedFile(fileId as MimeiId);
    
    if (file) {
      sharedFile.value = {
        ...file,
        url: file.url, // Ensure the URL is stored
      };
      
      if (file.isDirectory) {
        // Set the root path to the shared directory path
        rootPath.value = file.path;
        // Set the root directory name
        rootDirectoryName.value = file.name;
        // Initialize history with root
        directoryHistory.value = [rootPath.value];
        // Fetch directory contents
        await fetchDirectoryContents(rootPath.value, file.url);
      } else {
        // If the shared file is a single file, create a virtual directory view
        rootPath.value = file.path.substring(0, file.path.lastIndexOf('/'));
        currentPath.value = rootPath.value;
        directoryHistory.value = [rootPath.value];
        
        // Get the parent directory name
        const pathParts = rootPath.value.split('/');
        rootDirectoryName.value = pathParts[pathParts.length - 1] || 'Root';
        
        // Create a virtual directory listing with just this file
        file.url = `${file.url}/netd/${encodeURIComponent(file.path)}`
        directoryContents.value = [file];
      }
      
      // Reset retry count on success
      retryCount.value = 0;
    } else {
      error.value = 'File not found.';
      
      // Retry logic
      if (retryCount.value < maxRetries) {
        retryCount.value++;
        console.log(`Retrying (${retryCount.value}/${maxRetries}) in 5 seconds...`);
        setTimeout(loadSharedFile, 5000);
      }
    }
  } catch (err: any) {
    console.error('Failed to load shared file:', err);
    error.value = err.message || 'Failed to load shared file';
    
    // Retry logic
    if (retryCount.value < maxRetries) {
      retryCount.value++;
      console.log(`Retrying (${retryCount.value}/${maxRetries}) in 5 seconds...`);
      setTimeout(loadSharedFile, 5000);
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

    <!-- Loading indicator -->
    <div v-if='loading' class='loading'>
      <div class="loading-spinner"></div>
      <p>Loading... {{ retryCount > 0 ? `(Retry ${retryCount}/${maxRetries})` : '' }}</p>
    </div>

    <!-- Error message -->
    <div v-if='error && retryCount >= maxRetries' class='error'>
      {{ error }}
    </div>

    <!-- File listing -->
    <table v-if='!loading && !error && filteredDirectoryContents.length > 0' class='file-list'>
      <thead>
        <tr>
          <th>Name</th>
          <th>Size</th>
          <th>Modified</th>
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
          <td class='file-date'>{{ formatDate(item.modified) }}</td>
          <td class='file-actions'>
            <template v-if='!item.isDirectory'>
              <button @click.stop='downloadFile(item)' class='action-button'>Download</button>
              <button @click.stop='viewFile(item)' class='action-button'>View</button>
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

.action-button {
  margin-right: 8px;
  padding: 6px 12px;
  background-color: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
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

.share-dialog {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.share-dialog-content {
  background-color: white;
  padding: 20px;
  border-radius: 5px;
  width: 80%;
  max-width: 500px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.share-dialog-content h3 {
  margin-top: 0;
  color: #2c3e50;
}

.share-dialog-content input {
  width: 100%;
  padding: 8px;
  margin: 10px 0;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.share-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 15px;
}

.share-actions button {
  padding: 8px 15px;
  cursor: pointer;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.share-actions button:hover {
  background-color: #0069d9;
}

.share-actions button:last-child {
  background-color: #6c757d;
}

.share-actions button:last-child:hover {
  background-color: #5a6268;
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