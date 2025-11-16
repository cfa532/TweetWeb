<script lang="ts" setup>
import { watch, onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useTweetStore } from "@/stores";
import { QRCoder, UserActions } from '@/views';
import { formatTimeDifference } from '@/lib';

const router = useRouter()
const tweetStore = useTweetStore()
const qrSize = 100
const props = defineProps({
    userId: { type: String, required: false },
})
const userId = computed(() => props.userId)
const avatarUrl = ref(import.meta.env.VITE_APP_LOGO)
const user = ref<User>()

// App download prompt and modal
const showDownloadPrompt = ref(false)
const showDownloadModal = ref(false)
const isDownloading = ref(false)

// Localization for download prompt
const downloadText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '下载APP获得最佳体验'
    } else if (language.startsWith('ja')) {
        return 'ネイティブアプリで最高の体験を'
    } else {
        return '下载APP获得最佳体验'
    }
})

// Localization for direct download
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
        return '在浏览器中打开链接'
    } else if (language.startsWith('ja')) {
        return 'ブラウザでリンクを開く'
    } else {
        return 'Open the link in browser'
    }
})

const downloadPageUrl = computed(() => {
    return `${window.location.origin}/apk`
})

const openDownloadModal = () => {
    showDownloadModal.value = true
}

const closeDownloadModal = () => {
    showDownloadModal.value = false
}

const openAppStore = () => {
    window.open('https://apps.apple.com/app/dtweet/id6751131431', '_blank')
}

const openPlayStore = () => {
    window.open('https://play.google.com/store/apps/details?id=us.fireshare.tweet', '_blank')
}

const openDirectDownload = () => {
    window.open('https://dtweet.app/download', '_blank')
}

const openInBrowser = () => {
    window.open(downloadPageUrl.value, '_blank')
}

const startDirectDownload = async () => {
    isDownloading.value = true
    try {
        await tweetStore.downloadBlob(tweetStore.installApk)
    } catch (error) {
        console.error('Download failed:', error)
    } finally {
        isDownloading.value = false
    }
}

onMounted(async () => {
    if (props.userId) {
        user.value = await tweetStore.getUser(props.userId)
    }
    // Show download prompt after 2 seconds
    setTimeout(() => {
        showDownloadPrompt.value = true
    }, 2000)
    
    setTimeout(() => {
        showDownloadPrompt.value = false
    }, 30000)
})
watch(userId, async (nv, ov) => {
    if (nv !== ov) {
        if (nv) {
            user.value = await tweetStore.getUser(nv)
            console.log(user.value)
        }
        else {
            user.value = undefined
        }
    }
})
</script>

<template>
    <div class="row mb-1">
        <div class="d-flex justify-content-between">
            <div class="d-flex">
                <div class="avatar me-2 ms-2 mt-1">
                    <img :src="user ? user.avatar : avatarUrl" @click="router.push({ name: 'main' })" alt="Logo"
                        class="rounded-circle" />
                </div>
                <!-- User Info -->
                <div v-if="user" class="user-info flex-grow-1">
                    <!-- Username, Alias, and Time -->
                    <div class="username-alias-time">
                        <span class="username fw-bold">{{ user.name }}</span>
                        <span class="alias text-muted">@{{ user.username }}</span>
                        <span class="time text-muted">
                            - {{ formatTimeDifference(user.timestamp as number) }}
                        </span>
                    </div>

                    <div class="mt-1">
                        <span class="alias text-muted">{{ user.profile }}</span>
                    </div>
                </div>
                <!-- Container for the link when no user -->
                <div v-else class="no-user-container">
                    <a href="http://tweet.fireshare.us">HTTP://tweet.fireshare.us</a>
                </div>
            </div>

        </div>
        <!-- Followers and Friends Links -->
        <div v-if="user" class="user-actions">
            <div v-if="user" class="links">
                <a href="#" @click.prevent="router.push(`/followers/${user.mid}`)" class="text-muted">{{
                    user.followersCount }} fans</a>
                <a href="#" @click.prevent="router.push(`/followings/${user.mid}`)" class="text-muted">{{
                    user.followingCount }} following</a>
                <a href="#"  class="text-muted">{{ user.tweetCount }} tweet</a>
            </div>
            <UserActions></UserActions>
        </div>
    </div>
    
    <!-- App Download Prompt for All Users -->
    <div v-if="showDownloadPrompt" class="download-prompt" @click="openDownloadModal">
        <div class="prompt-content">
            <div class="prompt-text">
                <p>{{ downloadText }} ⬇️</p>
            </div>
        </div>
    </div>
    
    <!-- Download Modal Popup -->
    <div v-if="showDownloadModal" class="modal-overlay" @click="closeDownloadModal">
        <div class="modal-content" @click.stop>
            <div class="modal-body">
                <div class="platform-options">
                    <!-- Direct Download -->
                    <div class="platform-option">
                        <div class="platform-qr" @click="startDirectDownload">
                            <QRCoder :url="downloadPageUrl" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                        <div class="platform-info">
                            <p v-if="isDownloading">{{ downloadingText }}</p>
                            <a v-else href="#" @click.prevent="openInBrowser" class="browser-link">{{ apkText }}</a>
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
                        <div class="platform-qr" @click="openAppStore">
                            <QRCoder url="https://apps.apple.com/app/dtweet/id6751131431" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                    </div>
                    
                    <!-- Android/Google Play -->
                    <div class="platform-option">
                        <div class="platform-icon">
                            <img src="/src/android.png" alt="Android" height="48" width="48" />
                        </div>
                        <div class="platform-qr" @click="openPlayStore">
                            <QRCoder url="https://play.google.com/store/apps/details?id=us.fireshare.tweet" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
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

.d-flex {
    margin: 2px 0px;
    display: flex;
    align-items: stretch;
    /* Changed from center to stretch */
    justify-content: space-between;
    /* Ensures space between elements */
    flex-wrap: nowrap;
    /* Prevents wrapping of the QR code */
    min-height: 60px;
    /* Added height to the parent */
}

.avatar img {
    object-fit: cover;
    width: 60px;
    height: 60px;
    cursor: pointer;
    transition: width 0.3s, height 0.3s;
    /* Smooth transition for size changes */
}

.user-info {
    flex-grow: 1;
    /* Allows the user info to take up remaining space */
    margin-left: 10px;
    /* Adds some space between avatar and user info */
    flex-wrap: wrap;
    /* Allows text to wrap on smaller screens */
}

.username-alias-time {
    display: flex;
    align-items: center;
    gap: 1px;
    flex-wrap: wrap;
    /* Allows text to wrap on smaller screens */
    font-size: 0.95rem;
}

.text-muted {
    font-size: 0.95rem;
}

.user-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
}

.links {
    padding-left: 10px;
    display: flex;
    width: 80%;
    /* Takes 80% of the container width */
}

.links a {
    color: #3d5563;
    text-decoration: none;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 10px;
    text-align: left;
}

.links a:hover {
    text-decoration: underline;
}

/* UserActions takes the remaining 20% */
:deep(UserActions) {
    width: 20%;
    flex-shrink: 0;
    text-align: right;
}

/* New styles for the link container */
.no-user-container {
    font-size: smaller;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    /* Align content to the bottom */
    flex-grow: 1;
}

@media (max-width: 600px) {
    .btn {
        font-size: 0.7rem;
    }

    .avatar img {
        width: 50px;
        height: 50px;
    }

    .user-info {
        line-height: 1.2;
        flex-grow: 1;
        margin-left: 1px;
        /* Adjusts margin for smaller screens */
    }

    .username-alias-time {
        gap: 2px;
        /* Reduces gap for smaller screens */
    }

    .links a {
        font-size: 0.9rem;
        /* Reduces font size for smaller screens */
    }

    .d-flex {
        min-height: 50px;
        /* Adjust height for smaller screens */
    }
}

@media (min-width: 1200px) {
    .avatar img {
        width: 60px;
        height: 60px;
    }

    .user-info {
        margin-left: 1px;
        /* Increases margin for larger screens */
    }

    .d-flex {
        min-height: 60px;
    }
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
    max-width: 400px;
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
    flex-shrink: 0;
    margin-left: 0;
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

@media (max-width: 768px) {
    .prompt-content {
        flex-direction: column;
        gap: 15px;
        text-align: center;
    }
    
    .prompt-text h5 {
        font-size: 1rem;
    }
    
    .prompt-text p {
        font-size: 0.85rem;
    }
    
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
    
    .platform-info {
        margin-right: 0;
        margin-bottom: 12px;
    }
}
</style>