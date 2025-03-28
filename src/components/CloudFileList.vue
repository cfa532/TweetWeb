<script setup lang='ts'>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { useTweetStore } from '@/stores';

// Get the server base URL from environment variables
const route = useRoute();
const tweetStore = useTweetStore()

const files = ref([] as FileSystemItem[]);
const currentPath = ref('');
const parentPath = ref(null);
const loading = ref(true);
const error = ref<string | null>(null);

const showShareDialog = ref(false);
const selectedFile = ref<FileSystemItem | undefined>();
const shareUrl = ref('');

// Computed property to split the current path into parts for breadcrumb
const pathParts = computed(() => {
  return currentPath.value ? currentPath.value.split('/').filter(Boolean) : [];
});

let TUS_SERVER_URL = ""
// Function to load directory contents
const loadDirectory = async (path = '') => {
  loading.value = true;
  error.value = null;

  try {
    console.log('Loading directory:', path);
    const response = await axios.get(`${TUS_SERVER_URL}/netd`, {
      params: { path }
    });

    console.log('Response:', response.data);

    // Filter out system files (starting with $)
    const filteredFiles = (response.data.files || []).filter((file: File) => !file.name.startsWith('$'));

    files.value = filteredFiles;
    currentPath.value = response.data.currentPath || '';
    parentPath.value = response.data.parentPath;
  } catch (err: any) {
    console.error('Failed to load directory:', err);
    error.value = err.message || 'Failed to load directory';
  } finally {
    loading.value = false;
  }
};

// Navigation functions
const navigateTo = (path: string) => {
  console.log('Navigating to:', path);
  // Instead of using router, directly load the directory
  loadDirectory(path);
};

const navigateToParent = () => {
  if (parentPath.value !== null) {
    navigateTo(parentPath.value);
  }
};

// File action functions
const viewFile = (file: FileSystemItem) => {
  window.open(`${TUS_SERVER_URL}/netd/${encodeURIComponent(file.path)}`, '_blank');
};

const downloadFile = (file: FileSystemItem) => {
  window.open(`${TUS_SERVER_URL}/netd/${encodeURIComponent(file.path)}?download=true`, '_blank');
};

const shareFile = async (file: FileSystemItem) => {
  selectedFile.value = file;
  console.log(file)
  const mid = await tweetStore.shareFile(file)
  // shareUrl.value = `${SERVER_BASE_URL}/netd/${encodeURIComponent(file.path)}`;
  shareUrl.value = `${window.location.origin}/shared/${mid}`;
  showShareDialog.value = true;
};

const shareDirectory = async (file: FileSystemItem) => {
  selectedFile.value = file
  console.log(file)
  const mid = await tweetStore.shareFile(file)
  shareUrl.value = `${window.location.origin}/shared/${mid}`;
  showShareDialog.value = true;
};

const copyShareUrl = () => {
  navigator.clipboard.writeText(shareUrl.value)
    .then(() => alert('URL copied to clipboard!'))
    .catch(err => console.error('Failed to copy URL:', err));
};

const closeShareDialog = () => {
  showShareDialog.value = false;
  selectedFile.value = undefined;
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

// Watch for route changes to reload directory
watch(
  () => route.query.path,
  (newPath) => {
    loadDirectory(newPath as string || '');
  }
);

// Available only to login server on its base host.
onMounted(() => {
  console.log('Component mounted, route query:', route.query);
  let ip = tweetStore.splitIpAndPort(tweetStore.loginUser?.providerIp as string)
    let port = tweetStore.loginUser?.cloudDrivePort ? tweetStore.loginUser?.cloudDrivePort : 8010
    TUS_SERVER_URL = `http://${ip}:${port}`
    console.log("TUS server", TUS_SERVER_URL)

  loadDirectory(route.query.path as string || '');
});
</script>

<template>
  <div class='netdisk-container'>
    <!-- Breadcrumb navigation -->
    <div class='breadcrumb'>
      <span @click='navigateTo("")' class='breadcrumb-link'>Root</span>
      <template v-for='(part, index) in pathParts' :key='index'>
        / <span @click='navigateTo(pathParts.slice(0, index + 1).join("/"))' class='breadcrumb-link'>{{ part }}</span>
      </template>
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
          <th>Modified</th>
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
          <td class='file-date'>{{ formatDate(item.modified) }}</td>
          <td class='file-actions'>
            <template v-if='!item.isDirectory'>
              <button @click.stop='downloadFile(item)' class='action-button'>Download</button>
              <button @click.stop='viewFile(item)' class='action-button'>View</button>
              <button @click.stop='shareFile(item)' class='action-button'>Share</button>
            </template>
            <template v-else>
              <button @click.stop='shareDirectory(item)' class='action-button'>Share</button>
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
}

.action-button {
  margin-right: 8px;
  padding: 4px 8px;
  background-color: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
}

.action-button:hover {
  background-color: #e9ecef;
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
</style>