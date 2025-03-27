<script setup lang='ts'>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore } from '@/stores';

// Get the server base URL from environment variables
const route = useRoute();
const fileId = route.params.mid;
const tweetStore = useTweetStore();

const files = ref([] as FileSystemItem[]); // This is not used anymore
const loading = ref(true);
const error = ref<string | null>(null);
const sharedFile = ref<FileSystemItem | null>(null);

// File action functions
const viewFile = (file: FileSystemItem) => {
  window.open(`${file.url}/netd/${encodeURIComponent(file.path)}`, '_blank');
};

const downloadFile = (file: FileSystemItem) => {
  window.open(`${file.url}/netd/${encodeURIComponent(file.path)}?download=true`, '_blank');
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
  <div class="file-browser-container">
    <header class="file-browser-header">
      <h1>Shared File</h1>
    </header>

    <main class="file-browser-content">
      <div v-if="loading" class="loading-indicator">
        <p>Loading...</p>
      </div>

      <div v-if="error" class="error-message">
        <p>Error: {{ error }}</p>
      </div>

      <div v-if="sharedFile" class="file-details">
        <section class="file-info">
          <h2>{{ sharedFile.name }}</h2>
          <p><strong>Size:</strong> {{ formatFileSize(sharedFile.size) }}</p>
          <p><strong>Modified:</strong> {{ formatDate(sharedFile.modified) }}</p>
        </section>

        <section class="file-actions">
          <button @click="downloadFile(sharedFile)" class="download-button">
            <i class="fas fa-download"></i> Download
          </button>
          <button @click="viewFile(sharedFile)" class="view-button">
            <i class="fas fa-eye"></i> View
          </button>
        </section>
      </div>

      <div v-else-if="!loading && !error" class="not-found-message">
        <p>File not found.</p>
      </div>
    </main>

    <footer class="file-browser-footer">
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

/* File Actions Section */
.file-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-start;
}

.download-button,
.view-button {
  background-color: #007bff;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 5px;
  cursor: pointer;
  transition: background-color 0.3s ease;
  display: flex;
  align-items: center;
  gap: 5px;
}

.download-button:hover,
.view-button:hover {
  background-color: #0056b3;
}

/* Font Awesome Icons */
.fas {
  margin-right: 5px;
}
</style>