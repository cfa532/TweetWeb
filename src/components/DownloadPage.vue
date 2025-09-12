<template>
  <div class="download-page">
    <div class="container">
      <div class="download-card">
        <div class="app-info">
          <img src="/src/ic_splash.png" alt="App Icon" class="app-icon" />
          <h1 class="app-name">DTweet</h1>
          <p class="app-description">Get the best experience with our native app</p>
        </div>
        
        <div class="download-section">
          <h2>{{ downloadTitle }}</h2>
          <p class="download-description">{{ downloadDescription }}</p>
          
          <div class="download-button-container">
            <button 
              @click="startDownload" 
              :disabled="isDownloading"
              class="download-button"
            >
              <span v-if="isDownloading" class="spinner"></span>
              {{ isDownloading ? downloadingText : downloadButtonText }}
            </button>
          </div>
          
          <div v-if="showInstructions" class="instructions">
            <h3>{{ instructionsTitle }}</h3>
            <ol class="instruction-steps">
              <li v-for="(step, index) in instructionSteps" :key="index">
                {{ step }}
              </li>
            </ol>
          </div>
        </div>
        
        <div class="alternative-options">
          <h3>{{ alternativeTitle }}</h3>
          <div class="store-buttons">
            <a 
              href="https://apps.apple.com/app/dtweet/id6751131431" 
              target="_blank" 
              class="store-button apple"
            >
              <img src="/src/apple.png" alt="App Store" />
              <span>App Store</span>
            </a>
            <a 
              href="https://play.google.com/store/apps/details?id=us.fireshare.tweet" 
              target="_blank" 
              class="store-button google"
            >
              <img src="/src/android.png" alt="Google Play" />
              <span>Google Play</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useTweetStore } from '@/stores'

const tweetStore = useTweetStore()
const isDownloading = ref(false)

// Localization
const language = computed(() => navigator.language || 'en')

const downloadTitle = computed(() => {
  if (language.value.startsWith('zh')) {
    return '下载 Android APK'
  } else if (language.value.startsWith('ja')) {
    return 'Android APK をダウンロード'
  } else {
    return 'Download Android APK'
  }
})

const downloadDescription = computed(() => {
  if (language.value.startsWith('zh')) {
    return '点击下方按钮下载最新版本的 DTweet Android 应用'
  } else if (language.value.startsWith('ja')) {
    return '下のボタンをクリックして最新バージョンの DTweet Android アプリをダウンロード'
  } else {
    return 'Click the button below to download the latest version of DTweet Android app'
  }
})

const downloadButtonText = computed(() => {
  if (language.value.startsWith('zh')) {
    return '下载 APK'
  } else if (language.value.startsWith('ja')) {
    return 'APK をダウンロード'
  } else {
    return 'Download APK'
  }
})

const downloadingText = computed(() => {
  if (language.value.startsWith('zh')) {
    return '下载中...'
  } else if (language.value.startsWith('ja')) {
    return 'ダウンロード中...'
  } else {
    return 'Downloading...'
  }
})

const showInstructions = computed(() => {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
})

const instructionsTitle = computed(() => {
  if (language.value.startsWith('zh')) {
    return '安装说明'
  } else if (language.value.startsWith('ja')) {
    return 'インストール手順'
  } else {
    return 'Installation Instructions'
  }
})

const instructionSteps = computed(() => {
  if (language.value.startsWith('zh')) {
    return [
      '下载完成后，如果文件显示为 .zip 格式，请将其重命名为 .apk 格式',
      '在 Android 设备上启用"未知来源"安装',
      '点击重命名后的 .apk 文件进行安装',
      '按照屏幕提示完成安装'
    ]
  } else if (language.value.startsWith('ja')) {
    return [
      'ダウンロード後、ファイルが .zip 形式で表示される場合は、.apk 形式にリネーム',
      'Android デバイスで「不明なソース」からのインストールを有効にする',
      'リネームした .apk ファイルをタップしてインストール',
      '画面の指示に従ってインストールを完了'
    ]
  } else {
    return [
      'After download, if the file appears as .zip format, rename it to .apk format',
      'Enable "Unknown sources" installation on your Android device',
      'Tap the renamed .apk file to install',
      'Follow the on-screen prompts to complete installation'
    ]
  }
})

const alternativeTitle = computed(() => {
  if (language.value.startsWith('zh')) {
    return '其他下载方式'
  } else if (language.value.startsWith('ja')) {
    return 'その他のダウンロード方法'
  } else {
    return 'Alternative Download Options'
  }
})

const startDownload = async () => {
  if (!tweetStore.installApk) {
    alert('Download link not available')
    return
  }
  
  isDownloading.value = true
  try {
    await tweetStore.downloadBlob(tweetStore.installApk)
  } catch (error) {
    console.error('Download failed:', error)
    alert('Download failed. Please try again.')
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
  border-radius: 20px;
  padding: 40px 30px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
  text-align: center;
}

.app-info {
  margin-bottom: 30px;
}

.app-icon {
  width: 80px;
  height: 80px;
  border-radius: 15px;
  margin-bottom: 15px;
}

.app-name {
  font-size: 28px;
  font-weight: bold;
  color: #333;
  margin: 0 0 10px 0;
}

.app-description {
  color: #666;
  font-size: 16px;
  margin: 0;
}

.download-section {
  margin-bottom: 30px;
}

.download-section h2 {
  font-size: 24px;
  color: #333;
  margin: 0 0 10px 0;
}

.download-description {
  color: #666;
  font-size: 14px;
  margin: 0 0 25px 0;
  line-height: 1.5;
}

.download-button-container {
  margin-bottom: 25px;
}

.download-button {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 50px;
  padding: 15px 40px;
  font-size: 18px;
  font-weight: bold;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0 auto;
  min-width: 200px;
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
  border-radius: 15px;
  padding: 20px;
  text-align: left;
  margin-top: 20px;
}

.instructions h3 {
  font-size: 18px;
  color: #333;
  margin: 0 0 15px 0;
  text-align: center;
}

.instruction-steps {
  margin: 0;
  padding-left: 20px;
}

.instruction-steps li {
  color: #666;
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 8px;
}

.alternative-options {
  border-top: 1px solid #eee;
  padding-top: 25px;
}

.alternative-options h3 {
  font-size: 18px;
  color: #333;
  margin: 0 0 20px 0;
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
  gap: 8px;
  padding: 12px 20px;
  border-radius: 25px;
  text-decoration: none;
  font-weight: bold;
  transition: transform 0.2s;
  border: 2px solid transparent;
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

.store-button img {
  width: 24px;
  height: 24px;
}

@media (max-width: 480px) {
  .download-card {
    padding: 30px 20px;
  }
  
  .app-name {
    font-size: 24px;
  }
  
  .download-button {
    padding: 12px 30px;
    font-size: 16px;
    min-width: 180px;
  }
  
  .store-buttons {
    flex-direction: column;
    align-items: center;
  }
  
  .store-button {
    width: 200px;
    justify-content: center;
  }
}
</style>
