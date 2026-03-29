<script lang="ts" setup>
import { watch, onMounted, ref, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from "@/stores";
import { QRCoder } from '@/views';
import { DownloadPrompt, DownloadModal } from '@/components';
import { formatTimeDifference } from '@/lib';
import { marked } from 'marked'
import leitherSetupNoticeEn from '@/content/leither-setup-notice.en.md?raw'
import leitherSetupNoticeZh from '@/content/leither-setup-notice.zh.md?raw'

const { t, locale } = useI18n();

const router = useRouter()
const route = useRoute()
const tweetStore = useTweetStore()
const isLoggedIn = computed(() => !!tweetStore.loginUser)
const isAccountMenuOpen = ref(false)
let accountMenuCloseTimer: ReturnType<typeof setTimeout> | null = null
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

const openAccountMenu = () => {
    if (accountMenuCloseTimer) {
        clearTimeout(accountMenuCloseTimer)
        accountMenuCloseTimer = null
    }
    isAccountMenuOpen.value = true
}

const closeAccountMenu = () => {
    if (accountMenuCloseTimer) {
        clearTimeout(accountMenuCloseTimer)
        accountMenuCloseTimer = null
    }
    isAccountMenuOpen.value = false
}

const scheduleCloseAccountMenu = () => {
    if (accountMenuCloseTimer) {
        clearTimeout(accountMenuCloseTimer)
    }
    accountMenuCloseTimer = setTimeout(() => {
        isAccountMenuOpen.value = false
        accountMenuCloseTimer = null
    }, 120)
}

const goToAccount = () => {
    closeAccountMenu()
    router.push({ name: 'account' })
}

const goToRegister = () => {
    closeAccountMenu()
    router.push({ name: 'account', query: { view: 'register', redirect: route.fullPath } })
}

const goToLogin = () => {
    closeAccountMenu()
    router.push({ name: 'account', query: { view: 'login', redirect: route.fullPath } })
}

function isValidCloudDrivePort(port: unknown): boolean {
    const normalizedPort = typeof port === 'string' ? Number.parseInt(port.trim(), 10) : port
    return typeof normalizedPort === 'number'
        && Number.isInteger(normalizedPort)
        && normalizedPort >= 1
        && normalizedPort <= 65535
}

async function countOriginalTweetsByUser(userId: string): Promise<number> {
    const user = tweetStore.loginUser
    if (!user?.client) return 0

    const pageSize = 50
    const maxPages = 20
    let originalTweetCount = 0

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        const response = await user.client.RunMApp("get_tweets_by_user", {
            aid: tweetStore.appId,
            ver: "last",
            userid: userId,
            pn: pageNumber,
            ps: pageSize,
            appuserid: userId,
        })

        if (response?.success !== true || !Array.isArray(response?.tweets)) {
            break
        }

        const tweets = response.tweets.filter((tweet: any) => tweet != null)
        if (tweets.length === 0) {
            break
        }

        originalTweetCount += tweets.filter((tweet: any) => {
            const hasTextContent = typeof tweet?.content === 'string' && tweet.content.trim().length > 0
            const hasAttachment = Array.isArray(tweet?.attachments) && tweet.attachments.length > 0
            return hasTextContent || hasAttachment
        }).length
        if (originalTweetCount >= 5) {
            return originalTweetCount
        }
    }

    return originalTweetCount
}

/** Parse markdown: first `# heading` line is the page title; the rest is rendered as HTML. */
function parseMarkdownNotice(raw: string): { title: string; htmlBody: string } {
    const normalized = raw.replace(/\r\n/g, '\n').trimStart()
    const h1Match = normalized.match(/^#\s+(.+?)\s*$/m)
    if (!h1Match) {
        return { title: 'Notice', htmlBody: marked.parse(normalized) as string }
    }
    const title = h1Match[1].trim()
    const blockStart = normalized.indexOf(h1Match[0])
    const afterHeading = normalized.slice(blockStart + h1Match[0].length).replace(/^\n+/, '')
    return { title, htmlBody: marked.parse(afterHeading) as string }
}

function escapeHtmlForNotice(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function openLeitherSetupInfoPage(targetWindow?: Window | null) {
    const isChinese = locale.value?.toLowerCase().startsWith('zh')
    const raw = isChinese ? leitherSetupNoticeZh : leitherSetupNoticeEn
    const { title, htmlBody } = parseMarkdownNotice(raw)
    const pageTitle = escapeHtmlForNotice(title)

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${pageTitle}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f7fafc; color: #1f2937; line-height: 1.6; }
    .card { max-width: 760px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; box-shadow: 0 8px 20px rgba(0,0,0,0.06); }
    h1 { margin-top: 0; font-size: 1.35rem; }
    .notice-body p { margin: 0 0 1em; }
    .notice-body p:last-child { margin-bottom: 0; }
    .notice-body ul, .notice-body ol { margin: 0 0 1em; padding-left: 1.6em; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${pageTitle}</h1>
    <div class="notice-body">${htmlBody}</div>
  </div>
</body>
</html>`

    const win = targetWindow || window.open('', '_blank')
    if (!win) return

    win.document.open()
    win.document.write(html)
    win.document.close()
}

const uploadTweet = async () => {
    closeAccountMenu()
    const loginUser = tweetStore.loginUser
    const hasValidCloudDrivePort = isValidCloudDrivePort(loginUser?.cloudDrivePort)

    // If cloudDrivePort is valid, always navigate directly to editor.
    if (hasValidCloudDrivePort) {
        router.push({ name: 'post' })
        return
    }

    const preOpenedWindow = window.open('', '_blank')

    if (loginUser?.mid) {
        try {
            const originalTweetCount = await countOriginalTweetsByUser(loginUser.mid)

            if (originalTweetCount >= 5 && !hasValidCloudDrivePort) {
                openLeitherSetupInfoPage(preOpenedWindow)
                return
            }
        } catch (error) {
            console.error('[publish pre-check] Failed to validate original tweet threshold:', error)
        }
    }

    if (preOpenedWindow && !preOpenedWindow.closed) {
        preOpenedWindow.close()
    }
    router.push({ name: 'post' })
}

const openNetdisk = () => {
    closeAccountMenu()
    router.push({ name: 'netdisk' })
}

const logout = () => {
    closeAccountMenu()
    tweetStore.logout()
    sessionStorage.setItem('isBot', 'No')
    location.reload()
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
        user.value = await tweetStore.getUser(nv, true)
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
            <div class="account-menu-wrapper" @mouseenter="openAccountMenu" @mouseleave="scheduleCloseAccountMenu">
                <a href="#" class="account-btn" @click.prevent="isAccountMenuOpen = !isAccountMenuOpen"
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
                <div v-if="isAccountMenuOpen" class="account-dropdown">
                    <a v-if="!isLoggedIn" href="#" class="account-dropdown-item" @click.prevent="goToLogin">{{ $t('auth.login')
                        }}</a>
                    <a v-if="!isLoggedIn" href="#" class="account-dropdown-item" @click.prevent="goToRegister">{{
                        $t('auth.register') }}</a>

                    <template v-else>
                        <a href="#" class="account-dropdown-item" @click.prevent="uploadTweet">{{ $t('common.publish') }}</a>
                        <a href="#" class="account-dropdown-item" @click.prevent="openNetdisk">{{ $t('userActions.netdisk') }}</a>
                        <a href="#" class="account-dropdown-item" @click.prevent="goToAccount">{{ $t('auth.account') }}</a>
                        <a href="#" class="account-dropdown-item" @click.prevent="logout">{{ $t('auth.logout') }}</a>
                    </template>
                </div>
            </div>
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
    color: #ccd0d4;
}

.text-muted {
    font-size: 0.95rem;
    color: #ccd0d4 !important;
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
    color: #ccd0d4 !important;
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

/* New styles for the link container */
.no-user-container {
    font-size: smaller;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    /* Align content to the bottom */
    flex-grow: 1;
}

.no-user-container a {
    color: #ccd0d4;
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
    color: #ccd0d4;
    padding: 4px 20px 8px 10px;
    text-decoration: none;
    flex-shrink: 0;
    display: flex;
    align-items: center;
}

.account-btn:hover {
    color: #ccd0d4;
    background-color: transparent !important;
}

.account-avatar {
    width: 32px;
    height: 32px;
    object-fit: cover;
}

.account-menu-wrapper {
    position: relative;
    flex-shrink: 0;
    padding-bottom: 2px;
    margin-bottom: -2px;
}

.account-dropdown {
    position: absolute;
    top: calc(100% - 2px);
    right: 10px;
    min-width: 170px;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    border: 1px solid #e6ecf0;
    z-index: 30;
    overflow: hidden;
}

.account-dropdown-item {
    display: block;
    padding: 10px 12px;
    color: #4a4a4a;
    text-decoration: none;
    font-size: 0.9rem;
}

.account-dropdown-item:hover {
    background: #ecf3f8;
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