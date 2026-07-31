<template>
  <div class="download-page">
    <div class="container">
      <div class="download-card">
        <div class="app-info">
          <img src="/src/ic_splash.png" alt="App Icon" class="app-icon" />
          <h1 class="app-name">DTweet</h1>
        </div>
        
        <div class="download-section">
          <div class="browser-notice">
            <div class="notice-icon">🌐</div>
            <p class="notice-text">{{ $t('download.page.browserNotice') }}</p>
          </div>
          
          <div class="download-button-container">
            <button 
              @click="startDownload" 
              :disabled="isDownloading"
              class="download-button"
            >
              <span v-if="isDownloading" class="spinner"></span>
              {{ isDownloading ? $t('download.page.downloading') : $t('download.page.downloadAndroidApk') }}
            </button>
          </div>
          
          <div v-if="showInstructions" class="instructions">
            <h3>{{ $t('download.page.instructionsTitle') }}</h3>
            <ol class="instruction-steps">
              <li v-for="stepKey in instructionStepKeys" :key="stepKey">
                {{ $t(stepKey) }}
              </li>
            </ol>
          </div>
        </div>
        
        <div class="alternative-options">
          <h3>{{ $t('download.page.alternativeOptions') }}</h3>
          <div class="store-buttons">
            <a 
              href="https://apps.apple.com/app/dtweet/id6751131431" 
              target="_blank" 
              rel="noopener noreferrer"
              class="store-button apple"
            >
              <svg class="store-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M17.05 20.28c-.95.92-1.99.78-2.99.35-1.06-.44-2.03-.46-3.15 0-1.4.6-2.14.43-3-.35C3.03 15.25 3.75 7.59 9.3 7.31c1.35.07 2.29.74 3.08.79 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.78 4.09ZM12.03 7.25C11.89 5.02 13.69 3.18 15.77 3c.29 2.58-2.34 4.5-3.74 4.25Z"/>
              </svg>
              <span>{{ $t('download.page.appStore') }}</span>
            </a>
            <a 
              href="https://play.google.com/store/apps/details?id=us.fireshare.tweet" 
              target="_blank" 
              rel="noopener noreferrer"
              class="store-button google"
            >
              <svg class="store-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M3 20.5v-17c0-.59.34-1.11.84-1.35L13.69 12l-9.85 9.85A1.5 1.5 0 0 1 3 20.5Zm13.81-5.38L6.05 21.34l8.49-8.49 2.27 2.27Zm3.35-4.31c.37.28.59.71.59 1.19s-.22.9-.57 1.18l-2.29 1.32-2.5-2.5 2.5-2.5 2.27 1.31ZM6.05 2.66l10.76 6.22-2.27 2.27-8.49-8.49Z"/>
              </svg>
              <span>{{ $t('download.page.googlePlay') }}</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTweetStore } from '@/stores'

const tweetStore = useTweetStore()
const { t } = useI18n()
const isDownloading = ref(false)

const showInstructions = computed(() => {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
})

const instructionStepKeys = [
  'download.page.instructionStepRename',
  'download.page.instructionStepUnknownSources',
  'download.page.instructionStepInstall',
  'download.page.instructionStepComplete',
] as const

const startDownload = async () => {
  if (!tweetStore.installApk) {
    alert(t('download.page.linkUnavailable'))
    return
  }
  
  isDownloading.value = true
  try {
    await tweetStore.downloadBlob(tweetStore.installApk)
  } catch (error) {
    console.error('Download failed:', error)
    alert(t('download.page.downloadFailed'))
  } finally {
    isDownloading.value = false
  }
}

onMounted(() => {
  // Auto-start download if coming from QR code
  const urlParams = new URLSearchParams(window.location.search)
  if (urlParams.get('auto') === 'true') {
    setTimeout(() => {
      startDownload()
    }, 1000)
  }
})
</script>

<style scoped>
.download-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.container {
  max-width: 500px;
  width: 100%;
}

.download-card {
  background: white;
  border-radius: 15px;
  padding: 25px 20px;
  box-shadow: 0 15px 30px rgba(0, 0, 0, 0.1);
  text-align: center;
}

.app-info {
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 15px;
  justify-content: center;
}

.app-icon {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  flex-shrink: 0;
}

.app-name {
  font-size: 24px;
  font-weight: bold;
  color: #333;
  margin: 0;
}

.app-description {
  color: #666;
  font-size: 14px;
  margin: 0;
}

.download-section {
  margin-bottom: 20px;
}

.browser-notice {
  background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
  border: 1px solid #bbdefb;
  border-radius: 10px;
  padding: 12px 15px;
  margin-bottom: 15px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.notice-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.notice-text {
  color: #1976d2;
  font-size: 13px;
  font-weight: 500;
  margin: 0;
  line-height: 1.4;
}

.download-section h2 {
  font-size: 20px;
  color: #333;
  margin: 0 0 8px 0;
}

.download-description {
  color: #666;
  font-size: 13px;
  margin: 0 0 18px 0;
  line-height: 1.4;
}

.download-button-container {
  margin-bottom: 18px;
}

.download-button {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 25px;
  padding: 12px 30px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 auto;
  min-width: 180px;
}

.download-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
}

.download-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid transparent;
  border-top: 2px solid white;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.instructions {
  background: #f8f9fa;
  border-radius: 12px;
  padding: 15px;
  text-align: left;
  margin-top: 15px;
}

.instructions h3 {
  font-size: 16px;
  color: #333;
  margin: 0 0 12px 0;
  text-align: center;
}

.instruction-steps {
  margin: 0;
  padding-left: 18px;
}

.instruction-steps li {
  color: #666;
  font-size: 13px;
  line-height: 1.4;
  margin-bottom: 6px;
}

.alternative-options {
  border-top: 1px solid #eee;
  padding-top: 18px;
}

.alternative-options h3 {
  font-size: 16px;
  color: #333;
  margin: 0 0 15px 0;
}

.store-buttons {
  display: flex;
  gap: 15px;
  justify-content: center;
  flex-wrap: wrap;
}

.store-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: 20px;
  text-decoration: none;
  font-weight: bold;
  transition: transform 0.2s;
  border: 2px solid transparent;
  font-size: 14px;
}

.store-button.apple {
  background: #000;
  color: white;
}

.store-button.google {
  background: #01875f;
  color: white;
}

.store-button:hover {
  transform: translateY(-2px);
}

.store-icon {
  width: 22px;
  height: 22px;
  display: block;
  flex-shrink: 0;
}

@media (max-width: 480px) {
  .download-card {
    padding: 20px 15px;
  }
  
  .app-name {
    font-size: 22px;
  }
  
  .download-button {
    padding: 10px 25px;
    font-size: 15px;
    min-width: 160px;
  }
  
  .store-buttons {
    flex-direction: column;
    align-items: center;
  }
  
  .store-button {
    width: 180px;
    justify-content: center;
  }
}
</style>
