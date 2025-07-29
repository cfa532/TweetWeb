<script setup lang='ts'>
// --- Imports and Store Setup ---
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { useTweetStore } from '@/stores';

// --- State and Store References ---
const route = useRoute();
const router = useRouter();
const tweetStore = useTweetStore()

// --- Reactive State ---
const files = ref([] as FileSystemItem[]); // List of files/directories in the current directory
const currentPath = ref(''); // Current directory path
const parentPath = ref(null); // Parent directory path
const loading = ref(true); // Loading state
const error = ref<string | null>(null); // Error message
const isSharing = ref(false); // Sharing state
const showShareDialog = ref(false); // Show/hide share dialog
const selectedFile = ref<FileSystemItem | undefined>(); // File selected for sharing
const shareUrl = ref(''); // URL for sharing

// --- Computed Properties ---
// Split the current path for breadcrumb navigation
const pathParts = computed(() => {
  return currentPath.value ? currentPath.value.split('/').filter(Boolean) : [];
});

let TUS_SERVER_URL = ""

// --- Directory Loading ---
// Load the contents of a directory from the server
const loadDirectory = async (path = '') => {
  loading.value = true;
  error.value = null;
  try {
    console.log('Loading directory:', path);
    const username = tweetStore.loginUser?.username;
    if (!username) {
      throw new Error('Username is required');
    }
    // Fetch directory listing from the backend
    const response = await fetch(`${TUS_SERVER_URL}/netd?path=${encodeURIComponent(path)}`, {
      headers: {
        'x-username': username
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log('Response:', data);
    // Filter out system files (starting with $)
    const filteredFiles = (data.files || []).filter((file: File) => !file.name.startsWith('$'));
    files.value = filteredFiles;
    currentPath.value = data.currentPath || '';
    parentPath.value = data.parentPath;
  } catch (err: any) {
    console.error('Failed to load directory:', err);
    error.value = err.message || 'Failed to load directory';
  } finally {
    loading.value = false;
  }
};

// --- Navigation Functions ---
// Navigate to a specific directory
const navigateTo = (path: string) => {
  console.log('Navigating to:', path);
  loadDirectory(path);
};
// Navigate to the parent directory
const navigateToParent = () => {
  if (parentPath.value !== null) {
    navigateTo(parentPath.value);
  }
};

// --- File Action Functions ---
// Open a file for viewing in a new tab
const viewFile = (file: FileSystemItem) => {
  const username = tweetStore.loginUser?.username;
  window.open(`${TUS_SERVER_URL}/netd/${encodeURIComponent(file.path)}?username=${username}`, '_blank');
};
// Download a file
const downloadFile = (file: FileSystemItem) => {
  const username = tweetStore.loginUser?.username;
  window.open(`${TUS_SERVER_URL}/netd/${encodeURIComponent(file.path)}?download=true&username=${username}`, '_blank');
};
// Share a single file and show the share dialog
const shareFile = async (file: FileSystemItem) => {
  selectedFile.value = file;
  isSharing.value = true;
  try {
    const mid = await tweetStore.shareFile(file);
    shareUrl.value = `${window.location.origin}/shared/${mid}`;
    console.log(file, shareUrl.value);
    showShareDialog.value = true;
  } catch (error) {
    console.error('Error sharing file:', error);
    alert('Failed to share file. Please try again.');
  } finally {
    isSharing.value = false;
  }
};
// Share a directory and show the share dialog
const shareDirectory = async (file: FileSystemItem) => {
  selectedFile.value = file;
  console.log(file);
  isSharing.value = true;
  try {
    const mid = await tweetStore.shareFile(file);
    shareUrl.value = `${window.location.origin}/shared/${mid}`;
    showShareDialog.value = true;
  } catch (error) {
    console.error('Error sharing directory:', error);
    alert('Failed to share directory. Please try again.');
  } finally {
    isSharing.value = false;
  }
};
// Copy the share URL to clipboard
const copyShareUrl = () => {
  navigator.clipboard.writeText(shareUrl.value)
    .then(() => alert('URL copied to clipboard!'))
    .catch(err => console.error('Failed to copy URL:', err));
};
// Close the share dialog
const closeShareDialog = () => {
  showShareDialog.value = false;
  selectedFile.value = undefined;
};

// --- Utility Functions ---
// Format file size in human-readable form
const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// --- Directory Navigation and Lifecycle ---
// Watch for route changes to reload directory
watch(
  () => route.query.path,
  (newPath) => {
    loadDirectory(newPath as string || '');
  }
);
// On component mount, set up TUS server URL and load initial directory
onMounted(() => {
  console.log('Component mounted, route query:', route.query);
  let ip = tweetStore.getIpWithoutPort(tweetStore.loginUser?.providerIp as string)
  TUS_SERVER_URL = `http://${ip}:${tweetStore.loginUser?.cloudDrivePort}`
  console.log("TUS server", TUS_SERVER_URL)
  loadDirectory(route.query.path as string || '');
});
// Navigate to upload file page
function uploadFile() {
  router.push({
    name: "uploadFile", 
  })
}
// Navigate to user home page
function goHome() {
  router.push({
    name: "UserPage", 
    params: {authorId: tweetStore.loginUser?.mid}
  })
}
</script>

<template>
  <div class='netdisk-container'>
    <!-- Breadcrumb navigation -->
    <div class='breadcrumb'>
      <span @click='navigateTo("")' class='breadcrumb-link'>Root</span>
      <template v-for='(part, index) in pathParts' :key='index'>
        / <span @click='navigateTo(pathParts.slice(0, index + 1).join("/"))' class='breadcrumb-link'>{{ part }}</span>
      </template>
      <span class="breadcrumb-separator" v-if="pathParts.length > 0">|</span>
      <span @click='uploadFile' class='breadcrumb-link home-link'>Upload</span>
      <span @click='goHome' class='breadcrumb-link home-link'>Home</span>
    </div>

    <!-- Loading indicator -->
    <div v-if='loading' class='loading'>
      Loading...
    </div>

    <!-- Error message -->
    <div v-if='error' class='error'>
      {{ error }}
    </div>

    <!-- File listing -->
    <table v-if='!loading && !error && files.length > 0' class='file-list'>
      <thead>
        <tr>
          <th>Name</th>
          <th>Size</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <!-- Parent directory link -->
        <tr v-if='currentPath'>
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
        <tr v-for='item in files' :key='item.path'>
          <td>
            <div @click='item.isDirectory ? navigateTo(item.path) : viewFile(item)' class='file-link'>
              <span :class='item.isDirectory ? "folder-icon" : "file-icon"'>
                {{ item.isDirectory ? '📁' : '📄' }}
              </span>
              <span class='file-name'>{{ item.name }}</span>
            </div>
          </td>
          <td class='file-size'>{{ item.isDirectory ? '-' : formatFileSize(item.size) }}</td>
          <td class='file-actions'>
            <template v-if='!item.isDirectory'>
              <button @click.stop='downloadFile(item)' class='action-button' title="Download">
                <span class='action-icon'>⬇️</span>
              </button>
              <button @click.stop='viewFile(item)' class='action-button' title="View">
                <span class='action-icon'>▶️</span>
              </button>
              <button @click.stop='shareFile(item)' class='action-button' :disabled="isSharing" title="Share">
                <span v-if="isSharing && selectedFile?.path === item.path" class="loading-spinner"></span>
                <span v-else class='action-icon'>🔗</span>
              </button>
            </template>
            <template v-else>
              <button @click.stop='shareDirectory(item)' class='action-button' :disabled="isSharing" title="Share">
                <span v-if="isSharing && selectedFile?.path === item.path" class="loading-spinner"></span>
                <span v-else class='action-icon'>🔗</span>
              </button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- No files message -->
    <div v-if='!loading && !error && files.length === 0' class='no-files'>
      This directory is empty.
    </div>

    <!-- Share dialog -->
    <div v-if='showShareDialog' class='share-dialog'>
      <div class='share-dialog-content'>
        <h3>Share {{ selectedFile?.name }}</h3>
        <p>File URL:</p>
        <input type='text' readonly :value='shareUrl' @click='($event.target as HTMLInputElement).select()' />
        <div class='share-actions'>
          <button @click='copyShareUrl'>Copy</button>
          <button @click='closeShareDialog'>Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.netdisk-container {
  font-family: Arial, sans-serif;
  margin: 0;
  padding: 20px;
  color: #333;
}

h1 {
  margin-top: 0;
  border-bottom: 1px solid #eee;
  padding-bottom: 10px;
}

.breadcrumb {
  margin-bottom: 20px;
  background-color: #f8f9fa;
  padding: 8px 15px;
  border-radius: 4px;
}

.breadcrumb-link {
  color: #007bff;
  text-decoration: none;
  cursor: pointer;
}

.breadcrumb-link:hover {
  text-decoration: underline;
}
.breadcrumb-separator {
  margin: 0 8px;
  color: #6c757d;
}

.home-link {
  margin-left: 8px;
  color: #28a745; /* Different color to distinguish it */
}
.file-list {
  width: 100%;
  border-collapse: collapse;
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
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
  justify-content: flex-start;
}

.action-icon {
  font-size: 14px;
}

.action-button {
  margin-right: 8px;
  padding: 6px 12px;
  background-color: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
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

.action-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.loading,
.error,
.no-files {
  padding: 20px;
  text-align: center;
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
}

.share-dialog-content input {
  width: 100%;
  padding: 8px;
  margin: 10px 0;
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
}

@media (max-width: 768px) {
  .file-date {
    display: none;
  }
}

/* Add styles for the loading spinner */
.loading-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-radius: 50%;
  border-top-color: #007bff;
  animation: spin 1s ease-in-out infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>