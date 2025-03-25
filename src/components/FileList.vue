  <script setup>
  function isImage(type) {
    return type.startsWith('image/');
  }
  
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
    else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
    else return (bytes / 1073741824).toFixed(2) + ' GB';
  }
  
  function viewFile(fileId, fileType) {
    const fileUrl = `${tusServerUrl}/files/${fileId}`;
    
    if (isImage(fileType)) {
      // Open image in new tab
      window.open(fileUrl, '_blank');
    } else if (fileType === 'application/pdf') {
      // Open PDF in new tab
      window.open(fileUrl, '_blank');
    } else {
      // For other file types, trigger download
      downloadFile(fileId);
    }
  }
  </script>

<template>
    <div>
      <div v-for="file in files" :key="file.id" class="file-item">
        <div class="file-info">
          <span>{{ file.name }}</span>
          <span>{{ formatFileSize(file.size) }}</span>
        </div>
        
        <div class="file-actions">
          <button @click="downloadFile(file.id)">Download</button>
          <button @click="viewFile(file.id, file.type)">View</button>
        </div>
        
        <!-- Preview for images -->
        <img v-if="isImage(file.type)" 
             :src="`${tusServerUrl}/files/${file.id}`" 
             class="file-preview" />
      </div>
    </div>
</template>
