<script setup lang='ts'>
import { ref, computed, onMounted } from 'vue';
import type { PropType } from 'vue';
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';
import { QRCoder } from '@/views';

const props = defineProps({
  author: { type: Object as PropType<User>, required: true },
  timestamp: { type: Number, required: false },
  isRetweet: { type: Boolean, required: false, default: false },
  by: { type: String, required: false }
});

const tweetStore = useTweetStore();
const router = useRouter();

// Download prompt variables
const showDownloadPrompt = ref(false)
const showDownloadModal = ref(false)
const isDownloading = ref(false)
const modalQrSize = 100

function openUserPage(userId: string) {
  tweetStore.addFollowing(userId);
  router.push(`/author/${userId}`);
}

// Download prompt computed properties
const downloadText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '使用我们的APP获得最佳体验'
    } else if (language.startsWith('ja')) {
        return 'ネイティブアプリで最高の体験を'
    } else {
        return 'Get the best experience with our native app'
    }
})

const directDownloadText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '直接下载安卓 APK'
    } else if (language.startsWith('ja')) {
        return '直接ダウンロード Android APK'
    } else {
        return 'Download Android APK'
    }
})

const apkText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '在浏览器中打开链接'
    } else if (language.startsWith('ja')) {
        return 'ブラウザでリンクを開く'
    } else {
        return 'Open the link in browser'
    }
})

const downloadingText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '下载中...'
    } else if (language.startsWith('ja')) {
        return 'ダウンロード中...'
    } else {
        return 'Downloading...'
    }
})

// Download prompt functions
function openDownloadModal() {
    showDownloadModal.value = true
}

function closeDownloadModal() {
    showDownloadModal.value = false
}

function openAppStore() {
    window.open('https://apps.apple.com/app/dtweet/id6751131431', '_blank')
}

function openPlayStore() {
    window.open('https://play.google.com/store/apps/details?id=us.fireshare.tweet', '_blank')
}

async function startDirectDownload() {
    if (tweetStore.installApk) {
        isDownloading.value = true
        try {
            window.open(tweetStore.installApk, '_blank')
        } catch (error) {
            console.error('Failed to open download link:', error)
        } finally {
            isDownloading.value = false
        }
    }
}

onMounted(() => {
    // Show download prompt after 2 seconds
    setTimeout(() => {
        showDownloadPrompt.value = true
    }, 2000)
    
    setTimeout(() => {
        showDownloadPrompt.value = false
    }, 30000)
})
</script>

<template>
  <div class='d-flex justify-content-between align-items-center' style='width: 100%; margin: 2px 0px'>
    <div class='d-flex align-items-center'>
      <div class='avatar me-2'>
        <img :src='author.avatar' alt='User Avatar' class='rounded-circle' @click.stop='openUserPage(author.mid)'>
      </div>
      <div class='user-info flex-grow-1'>
        <div v-if='isRetweet' class='label text-muted small'>
          Forwarded by @{{ by }}
        </div>
        <div class='username-alias-time'>
          <span class='username fw-bold'>{{ author.name }}</span>
          <span class='alias text-muted'>@{{ author.username }}</span>
        </div>
        <div class='mt-1'>
          <span v-if='props.timestamp' class='time text-muted'>{{ formatTimeDifference(props.timestamp as number) }}</span>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Download Modal Popup -->
  <div v-if="showDownloadModal" class="modal-overlay" @click="closeDownloadModal">
      <div class="modal-content" @click.stop>
          <div class="modal-body">
              <div class="platform-options">
                  <!-- iOS/App Store -->
                  <div class="platform-option" @click="openAppStore">
                      <div class="platform-icon">
                          <img src="/apple.png" alt="Apple" height="48" width="48" />
                      </div>
                      <div class="platform-qr">
                          <QRCoder url="https://apps.apple.com/app/dtweet/id6751131431" :size="modalQrSize" :logoSize="20"></QRCoder>
                      </div>
                  </div>
                  
                  <!-- Android/Google Play -->
                  <div class="platform-option" @click="openPlayStore">
                      <div class="platform-icon">
                          <img src="/android.png" alt="Android" height="48" width="48" />
                      </div>
                      <div class="platform-qr">
                          <QRCoder url="https://play.google.com/store/apps/details?id=us.fireshare.tweet" :size="modalQrSize" :logoSize="20"></QRCoder>
                      </div>
                  </div>
                  
                  <!-- Direct Download -->
                  <div class="platform-option" @click="startDirectDownload">
                      <div class="platform-qr">
                          <QRCoder :url="tweetStore.installApk" :size="modalQrSize" :logoSize="20"></QRCoder>
                      </div>
                      <div class="platform-info">
                          <h5>{{ directDownloadText }}</h5>
                          <p>{{ isDownloading ? downloadingText : apkText }}</p>
                      </div>
                      <div v-if="isDownloading" class="download-spinner">
                          <span class="spinner-border spinner-border-sm" role="status"></span>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  
</template>

<style scoped>
.btn {
  font-size: 0.8rem;
}

.header-divider {
  margin: 8px 0;
  border: none;
  border-top: 1px solid #e0e0e0;
  opacity: 0.6;
}

.text-muted {
  font-size: 0.95rem;
}
.username {
  font-size: 0.9rem;
}
.alias {
  font-size: 1rem;
}
.avatar {
  display: flex;
  align-items: center;
}
.avatar img {
  object-fit: cover;
  width: 50px;
  height: 50px;
  cursor: pointer;
}
.user-info {
  font-size: 0.9rem;
  flex-grow: 1;
}
.links a {
  color: #3d5563;
  text-decoration: none;
  font-size: 0.9rem;
}
.links a:hover {
  text-decoration: underline;
}

/* App Download Prompt Styles */
.download-prompt {
    position: relative;
    width: 100%;
    background: #1a1a1a;
    color: #ffffff;
    padding: 0 15px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    margin-top: 10px;
    margin-left: 4px;
    border-radius: 8px;
    cursor: pointer;
    transition: transform 0.2s ease;
    animation: rotateToVertical 0.6s ease-out;
    transform-style: preserve-3d;
    perspective: 1000px;
}

.download-prompt:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.prompt-content {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    max-width: 100%;
    margin: 0;
    gap: 8px;
}

.prompt-text p {
    margin: 0;
    font-size: 1.0rem;
    font-weight: 500;
    opacity: 0.9;
    line-height: 1.4;
}

.prompt-icon {
    font-size: 1rem;
    flex-shrink: 0;
}

/* Modal Styles */
.modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 2000;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 20px;
}

.modal-content {
    background: white;
    border-radius: 12px;
    max-width: 600px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
}

.modal-body {
    padding: 24px;
    padding-top: 24px;
}

.platform-options {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.platform-option {
    display: flex;
    align-items: center;
    padding: 20px;
    border: 2px solid #f0f0f0;
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
    background: #fafafa;
    gap: 20px;
    min-height: 60px;
}

.platform-option:last-child {
    padding-left: 20px;
    position: relative;
}

.platform-option:hover {
    border-color: #667eea;
    background: #f8f9ff;
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(102, 126, 234, 0.15);
}

.platform-icon {
    font-size: 2rem;
    margin-right: 0;
    width: 96px;
    text-align: center;
    flex-shrink: 0;
}

.platform-info {
    flex: 1;
    margin-right: 0;
    width: 96px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
}

.platform-info h5 {
    margin: 0 0 4px 0;
    color: #333;
    font-size: 1.1rem;
    font-weight: 600;
}

.platform-info p {
    margin: 0;
    color: #666;
    font-size: 0.9rem;
}

.platform-qr {
    display: flex;
    flex-direction: column;
    align-items: center;
}

.download-spinner {
    position: absolute;
    top: 50%;
    right: 20px;
    transform: translateY(-50%);
    color: #667eea;
}

@keyframes slideDown {
    from {
        transform: translateY(-100%);
        opacity: 0;
    }
    to {
        transform: translateY(0);
        opacity: 1;
    }
}

@keyframes rotateToVertical {
    from {
        transform: rotateX(90deg);
        opacity: 0;
    }
    to {
        transform: rotateX(0deg);
        opacity: 1;
    }
}
</style>