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
const viewFile = (file: FileSystemItem) => {
  window.open(`${file.url}`, '_blank');
};

const downloadFile = (file: FileSystemItem) => {
  window.open(`${file.url}?download=true`, '_blank');
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
  } catch (err: any) {
    console.error('Failed to load directory contents:', err);
    error.value = err.message || 'Failed to load directory contents';
  } finally {
    loading.value = false;
  }
};

// Navigation functions
const navigateTo = (path: string) => {
  if (sharedFile.value) {
    fetchDirectoryContents(path, sharedFile.value.url);
  }
};

const navigateToParent = () => {
  if (parentPath.value !== null && sharedFile.value && currentPath.value !== rootPath.value) {
    fetchDirectoryContents(parentPath.value, sharedFile.value.url);
    // Remove the last item from history
    directoryHistory.value.pop();
  }
};

const navigateToBreadcrumb = (index: number) => {
  if (sharedFile.value) {
    // If index is -1, navigate to the root (shared directory)
    if (index === -1) {
      fetchDirectoryContents(rootPath.value, sharedFile.value.url);
      directoryHistory.value = [rootPath.value];
      return;
    }
    
    // Otherwise, build the path from the root and the selected breadcrumb parts
    const relativeParts = pathParts.value.slice(0, index + 1);
    const path = rootPath.value + (relativeParts.length > 0 ? '/' + relativeParts.join('/') : '');
    
    fetchDirectoryContents(path, sharedFile.value.url);
    // Trim history to this point
    directoryHistory.value = directoryHistory.value.slice(0, index + 2);
  }
};

// Load initial directory on component mount
onMounted(async () => {
  try {
    loading.value = true;
    const file = await tweetStore.getSharedFile(fileId as string);
    if (file) {
      sharedFile.value = {
        ...file,
        url: file.url, // Ensure the URL is stored
      };
      
      if (file.isDirectory) {
        // Set the root path to the shared directory path
        rootPath.value = file.path;
        
        // Initialize history with root
        directoryHistory.value = [rootPath.value];
        
        // Fetch directory contents
        await fetchDirectoryContents(rootPath.value, file.url);
      }
    } else {
      error.value = 'File not found.';
    }
  } catch (err: any) {
    console.error('Failed to load shared file:', err);
    error.value = err.message || 'Failed to load shared file';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class='file-browser-container'>
    <header class='file-browser-header'>
      <h1>Shared File</h1>
    </header>

    <main class='file-browser-content'>
      <div v-if='loading' class='loading-indicator'>
        <p>Loading...</p>
      </div>

      <div v-if='error' class='error-message'>
        <p>Error: {{ error }}</p>
      </div>

      <!-- Single file view -->
      <div v-if='sharedFile && !sharedFile.isDirectory' class='file-details'>
        <section class='file-info'>
          <h2>{{ sharedFile.name }}</h2>
          <p><strong>Size:</strong> {{ formatFileSize(sharedFile.size) }}</p>
          <p><strong>Modified:</strong> {{ formatDate(sharedFile.modified) }}</p>
        </section>

        <section class='file-actions'>
          <button @click='downloadFile(sharedFile)' class='action-button'>
            <i class='fas fa-download'></i> Download
          </button>
          <button @click='viewFile(sharedFile)' class='action-button'>
            <i class='fas fa-eye'></i> View
          </button>
        </section>
      </div>

      <!-- Directory view -->
      <div v-else-if='sharedFile && sharedFile.isDirectory' class='directory-browser'>
        <!-- Breadcrumb navigation -->
        <div class='breadcrumb'>
          <span @click='navigateToBreadcrumb(-1)' class='breadcrumb-link'>Root</span>
          <template v-for='(part, index) in pathParts' :key='index'>
            / <span @click='navigateToBreadcrumb(index)' class='breadcrumb-link'>{{ part }}</span>
          </template>
        </div>

        <!-- Parent directory button - only show if not at root -->
        <div v-if='parentPath !== null && currentPath !== rootPath' class='parent-directory'>
          <button @click='navigateToParent' class='action-button'>
            <i class='fas fa-folder'></i> .. (Parent Directory)
          </button>
        </div>

        <!-- Directory contents -->
        <table v-if='filteredDirectoryContents.length > 0' class='file-list'>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for='item in filteredDirectoryContents' :key='item.path'>
              <td>
                <div @click='item.isDirectory ? navigateTo(item.path) : viewFile(item)' class='file-link'>
                  <i :class='item.isDirectory ? "fas fa-folder" : "fas fa-file"'></i>
                  <span class='file-name'>{{ item.name }}</span>
                </div>
              </td>
              <td class='file-size'>{{ item.isDirectory ? '-' : formatFileSize(item.size) }}</td>
              <td class='file-date'>{{ formatDate(item.modified) }}</td>
              <td class='file-actions'>
                <template v-if='!item.isDirectory'>
                  <button @click.stop='downloadFile(item)' class='action-button'>
                    <i class='fas fa-download'></i> Download
                  </button>
                  <button @click.stop='viewFile(item)' class='action-button'>
                    <i class='fas fa-eye'></i> View
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-else-if='!loading' class='no-files'>
          This directory is empty.
        </div>
      </div>

      <div v-else-if='!loading && !error' class='not-found-message'>
        <p>File not found.</p>
      </div>
    </main>

    <footer class='file-browser-footer'>
      <p>&copy; 2024 Shared File Browser</p>
    </footer>
  </div>
</template>

<style scoped>
/* General Styles */
.file-browser-container {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  background-color: #f8f9fa;
  color: #343a40;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.file-browser-header {
  background-color: #007bff;
  color: white;
  padding: 20px;
  text-align: center;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
}

.file-browser-content {
  padding: 20px;
  flex: 1;
}

.file-browser-footer {
  background-color: #343a40;
  color: white;
  text-align: center;
  padding: 10px;
  font-size: 0.8em;
}

/* Loading and Error Messages */
.loading-indicator,
.error-message,
.not-found-message {
  text-align: center;
  padding: 20px;
  border: 1px solid #ddd;
  border-radius: 5px;
  margin-bottom: 20px;
}

.error-message {
  color: #dc3545;
  border-color: #dc3545;
}

/* File Details Section */
.file-details {
  background-color: white;
  border: 1px solid #ddd;
  border-radius: 5px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.file-info h2 {
  margin-top: 0;
  color: #007bff;
}

.file-info p {
  margin-bottom: 10px;
}

/* Directory Browser */
.directory-browser {
  background-color: white;
  border: 1px solid #ddd;
  border-radius: 5px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

/* Breadcrumb */
.breadcrumb {
  margin-bottom: 20px;
  background-color: #f8f9fa;
  padding: 8px 15px;
  border-radius: 4px;
}

.breadcrumb-link {
  color: #007bff;
  cursor: pointer;
}

.breadcrumb-link:hover {
  text-decoration: underline;
}

/* Parent Directory */
.parent-directory {
  margin-bottom: 15px;
}

/* File List */
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

.file-link i {
  margin-right: 10px;
}

.fas.fa-folder {
  color: #ffc107;
}

.fas.fa-file {
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

/* File Actions */
.file-actions {
  white-space: nowrap;
}

.action-button {
  margin-right: 8px;
  padding: 6px 12px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.3s;
  display: flex;
  align-items: center;
  gap: 5px;
}

.action-button:hover {
  background-color: #0056b3;
}

.no-files {
  color: #6c757d;
  text-align: center;
  padding: 20px;
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
  }
}
</style>