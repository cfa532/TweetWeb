<script lang="ts" setup>
import { watch, onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from "@/stores";
import { QRCoder, UserActions } from '@/views';
import { DownloadPrompt, DownloadModal } from '@/components';
import { formatTimeDifference } from '@/lib';

const { t } = useI18n();

const router = useRouter()
const tweetStore = useTweetStore()
const isLoggedIn = computed(() => !!tweetStore.loginUser)
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

const openInBrowser = (url: string) => {
    window.open(url, '_blank')
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

onMounted(() => {
    // Show download prompt after 2 seconds
    setTimeout(() => {
        showDownloadPrompt.value = true
    }, 2000)

    setTimeout(() => {
        showDownloadPrompt.value = false
    }, 30000)
})
watch(userId, async (nv, ov) => {
    if (nv) {
        user.value = await tweetStore.getUser(nv)
    }
    else {
        user.value = undefined
    }
}, { immediate: true })
</script>

<template>
    <div class="mb-1">
        <div class="header-row">
            <div class="header-left">
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
            <a href="#" class="account-btn" @click.prevent="router.push('/account')"
                :title="isLoggedIn ? $t('auth.account') : $t('auth.login')">
                <img v-if="isLoggedIn && tweetStore.loginUser?.avatar" :src="tweetStore.loginUser.avatar"
                    class="account-avatar rounded-circle"
                    @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'" />
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                </svg>
            </a>
        </div>
        <!-- Followers and Friends Links -->
        <div v-if="user" class="user-actions">
            <div v-if="user" class="links">
                <a href="#" @click.prevent="router.push(`/followers/${user.mid}`)" class="text-muted">{{
                    user.followersCount }} {{ $t('profile.fans') }}</a>
                <a href="#" @click.prevent="router.push(`/followings/${user.mid}`)" class="text-muted">{{
                    user.followingCount }} {{ $t('profile.following') }}</a>
                <a href="#"  class="text-muted">{{ user.tweetCount }} {{ $t('profile.tweet') }}</a>
            </div>
            <UserActions></UserActions>
        </div>
    </div>
    
    <DownloadPrompt :show="showDownloadPrompt" @click="openDownloadModal" />

    <DownloadModal
        :show="showDownloadModal"
        :isDownloading="isDownloading"
        @close="closeDownloadModal"
        @startDownload="startDirectDownload"
        @openAppStore="openAppStore"
        @openPlayStore="openPlayStore"
        @openBrowser="openInBrowser"
    />
</template>

<style scoped>
.btn {
    font-size: 0.8rem;
}

.header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: nowrap;
    min-height: 56px;
    margin: 2px 0;
}

.header-left {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
}

.avatar img {
    object-fit: cover;
    width: 56px !important;
    height: 56px !important;
    max-width: none !important;
    max-height: none !important;
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

    .header-row {
        min-height: 50px;
    }
}

@media (min-width: 1200px) {
    .user-info {
        margin-left: 1px;
        /* Increases margin for larger screens */
    }
}

/* App Download Prompt Styles */

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

.account-btn {
    color: grey;
    padding: 4px 20px 8px 10px;
    text-decoration: none;
    flex-shrink: 0;
    display: flex;
    align-items: center;
}

.account-btn:hover {
    color: grey;
    background-color: transparent !important;
}

.account-btn img,
.account-btn svg {
    transition: transform 0.2s ease;
}

.account-btn:hover img,
.account-btn:hover svg {
    transform: scale(1.25);
}

.account-avatar {
    width: 32px;
    height: 32px;
    object-fit: cover;
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
</style>