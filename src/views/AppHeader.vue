<script lang="ts" setup>
import { watch, onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useTweetStore } from "@/stores";
import { QRCoder, UserActions } from '@/views';
import { formatTimeDifference } from '@/lib';

const router = useRouter()
const tweetStore = useTweetStore()
const qrSize = 60
const props = defineProps({
    userId: { type: String, required: false },
})
const userId = computed(() => props.userId)
const avatarUrl = ref(import.meta.env.VITE_APP_LOGO)
const user = ref<User>()

// App download prompt and modal
const showDownloadPrompt = ref(false)
const showDownloadModal = ref(false)

const openDownloadModal = () => {
    showDownloadModal.value = true
}

const closeDownloadModal = () => {
    showDownloadModal.value = false
}

const openAppStore = () => {
    window.open('https://apps.apple.com/app/dtweet/id1234567890', '_blank')
}

const openPlayStore = () => {
    window.open('https://play.google.com/store/apps/details?id=com.dtweet.app', '_blank')
}

const openDirectDownload = () => {
    window.open('https://dtweet.app/download', '_blank')
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
            <div class="d-flex align-items-start qr-container">
                <button class="btn btn-link" @click="tweetStore.downloadBlob(tweetStore.installApk)">APP ⬇️</button>
                <div class="qr-code-container">
                    <QRCoder :url="tweetStore.installApk" :size="qrSize" :logoSize=20></QRCoder>
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
                <p>Get the best experience with our native app</p>
            </div>
            <div class="prompt-icon">
                <span class="download-icon">⬇️</span>
            </div>
        </div>
    </div>
    
    <!-- Download Modal Popup -->
    <div v-if="showDownloadModal" class="modal-overlay" @click="closeDownloadModal">
        <div class="modal-content" @click.stop>
            <div class="modal-header">
                <h4>📱 Download dTweet App</h4>
                <button class="close-btn" @click="closeDownloadModal">&times;</button>
            </div>
            <div class="modal-body">
                <div class="platform-options">
                    <!-- iOS/App Store -->
                    <div class="platform-option" @click="openAppStore">
                        <div class="platform-icon">🍎</div>
                        <div class="platform-info">
                            <h5>iOS App Store</h5>
                            <p>For iPhone, iPad, and iPod</p>
                        </div>
                        <div class="platform-qr">
                            <QRCoder url="https://apps.apple.com/app/dtweet/id1234567890" :size="60" :logoSize="10"></QRCoder>
                        </div>
                    </div>
                    
                    <!-- Android/Google Play -->
                    <div class="platform-option" @click="openPlayStore">
                        <div class="platform-icon">🤖</div>
                        <div class="platform-info">
                            <h5>Google Play Store</h5>
                            <p>For Android devices</p>
                        </div>
                        <div class="platform-qr">
                            <QRCoder url="https://play.google.com/store/apps/details?id=com.dtweet.app" :size="60" :logoSize="10"></QRCoder>
                        </div>
                    </div>
                    
                    <!-- Direct Download -->
                    <div class="platform-option" @click="openDirectDownload">
                        <div class="platform-icon">💻</div>
                        <div class="platform-info">
                            <h5>Direct Download</h5>
                            <p>APK file for Android</p>
                        </div>
                        <div class="platform-qr">
                            <QRCoder url="https://dtweet.app/download" :size="60" :logoSize="10"></QRCoder>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.qr-container {
    display: flex;
    align-items: flex-end;
    /* Aligns items to the right */
}

.btn {
    font-size: 0.8rem;
}

.qr-code-container {
    display: flex;
    justify-content: center;
    align-items: center;
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
    .qr-container {
        flex-direction: column;
        /* Changes direction to column on small screens */
        align-items: center;
        /* Centers items horizontally */
    }

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
    width: fit-content;
    background: #1a1a1a;
    color: #ffffff;
    padding: 0 15px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    margin-top: 10px;
    margin-left: 4px;
    border-radius: 8px;
    cursor: pointer;
    transition: transform 0.2s ease;
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
    font-size: 0.9rem;
    opacity: 0.9;
    line-height: 1.2;
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

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px 0;
    border-bottom: 1px solid #eee;
    padding-bottom: 16px;
}

.modal-header h4 {
    margin: 0;
    color: #333;
    font-size: 1.3rem;
}

.close-btn {
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
    color: #999;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: background-color 0.2s ease;
}

.close-btn:hover {
    background-color: #f5f5f5;
    color: #666;
}

.modal-body {
    padding: 24px;
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
}

.platform-option:hover {
    border-color: #667eea;
    background: #f8f9ff;
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(102, 126, 234, 0.15);
}

.platform-icon {
    font-size: 2rem;
    margin-right: 16px;
    width: 48px;
    text-align: center;
}

.platform-info {
    flex: 1;
    margin-right: 16px;
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