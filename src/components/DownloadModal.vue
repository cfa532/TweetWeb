<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { QRCoder } from '@/views';

// Props
const props = defineProps<{
    show: boolean
    isDownloading: boolean
}>()

// Emits
const emit = defineEmits<{
    close: []
    startDownload: []
    openAppStore: []
    openPlayStore: []
    openBrowser: [url: string]
}>()

const qrSize = 100
const countdown = ref(6)
let countdownInterval: number | null = null

// Auto-close countdown when modal is shown
watch(() => props.show, (newShow) => {
    if (newShow) {
        countdown.value = 6
        if (countdownInterval) clearInterval(countdownInterval)
        countdownInterval = window.setInterval(() => {
            countdown.value--
            if (countdown.value <= 0) {
                if (countdownInterval) clearInterval(countdownInterval)
                emit('close')
            }
        }, 1000)
    } else {
        if (countdownInterval) {
            clearInterval(countdownInterval)
            countdownInterval = null
        }
    }
})

onUnmounted(() => {
    if (countdownInterval) {
        clearInterval(countdownInterval)
    }
})

// Localization
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

const apkText = computed(() => {
    const language = navigator.language || 'en'

    if (language.startsWith('zh')) {
        return '用浏览器下载安卓版apk'
    } else if (language.startsWith('ja')) {
        return 'ブラウザでAndroid APKをダウンロード'
    } else {
        return 'Download Android APK with browser'
    }
})

const downloadMessage = computed(() => {
    const language = navigator.language || 'en'

    if (language.startsWith('zh')) {
        return '下载APP以获得更好的体验'
    } else if (language.startsWith('ja')) {
        return 'より良い体験のためにアプリをダウンロード'
    } else {
        return 'Download app for better experience'
    }
})

const downloadPageUrl = computed(() => {
    return `${window.location.origin}/apk`
})
</script>

<template>
    <!-- Download Modal Popup -->
    <div v-if="show" class="modal-overlay" @click="emit('close')">
        <div class="modal-content" @click.stop>
            <div class="modal-header">
                <button type="button" class="btn-close" @click="emit('close')" aria-label="Close"></button>
            </div>
            <div class="modal-title-section">
                <div class="countdown-circle">
                    {{ countdown }}
                </div>
                <h5 class="modal-title">{{ downloadMessage }}</h5>
            </div>
            <div class="modal-body">
                <div class="platform-options">
                    <!-- Direct Download -->
                    <div class="platform-option">
                        <div class="platform-qr" @click="emit('startDownload')">
                            <QRCoder :url="downloadPageUrl" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                        <div class="platform-info">
                            <p v-if="isDownloading">{{ downloadingText }}</p>
                            <a v-else href="#" @click.prevent="emit('openBrowser', downloadPageUrl)" class="browser-link">{{ apkText }}</a>
                        </div>
                        <div v-if="isDownloading" class="download-spinner">
                            <span class="spinner-border spinner-border-sm" role="status"></span>
                        </div>
                    </div>

                    <!-- iOS/App Store -->
                    <div class="platform-option">
                        <div class="platform-icon">
                            <img src="/src/apple.png" alt="Apple" height="48" width="48" />
                        </div>
                        <div class="platform-qr" @click="emit('openAppStore')">
                            <QRCoder url="https://apps.apple.com/app/dtweet/id6751131431" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                    </div>

                    <!-- Android/Google Play -->
                    <div class="platform-option">
                        <div class="platform-icon">
                            <img src="/src/android.png" alt="Android" height="48" width="48" />
                        </div>
                        <div class="platform-qr" @click="emit('openPlayStore')">
                            <QRCoder url="https://play.google.com/store/apps/details?id=us.fireshare.tweet" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
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
    max-width: 400px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
}

.modal-header {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    padding: 16px 24px 0 24px;
    position: relative;
}

.countdown-circle {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #667eea;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.2rem;
    font-weight: 700;
    position: absolute;
    top: 50%;
    right: 24px;
    transform: translateY(-50%);
    z-index: 5;
    box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

.btn-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #999;
    padding: 4px;
    border-radius: 50%;
    transition: all 0.2s ease;
    z-index: 11;
}

.btn-close:hover {
    background: #f0f0f0;
    color: #666;
}

.modal-title-section {
    padding: 8px 80px 16px 24px;
    text-align: center;
    position: relative;
}

.modal-title {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: #333;
    line-height: 1.4;
    position: relative;
    z-index: 10;
}

.modal-body {
    padding: 0 24px 24px 24px;
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
    text-align: center;
    flex-shrink: 0;
}

.platform-info {
    flex: 1;
    margin-right: 0;
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
    cursor: pointer;
}

.download-spinner {
    position: absolute;
    top: 50%;
    right: 20px;
    transform: translateY(-50%);
    color: #667eea;
}

.browser-link {
    color: #667eea;
    text-decoration: none;
    cursor: pointer;
    transition: color 0.2s ease;
}

.browser-link:hover {
    color: #5a6fd8;
    text-decoration: underline;
}

@media (max-width: 768px) {
    .modal-content {
        margin: 20px;
        max-height: calc(100vh - 40px);
    }

    .platform-option {
        flex-direction: column;
        text-align: center;
        gap: 12px;
    }

    .platform-icon {
        margin-right: 0;
        margin-bottom: 8px;
    }
}
</style>