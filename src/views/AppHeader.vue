<script lang="ts" setup>
import { watch, onMounted, ref, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from "@/stores";
import { useAlertStore } from '@/stores/alert.store';
import { DownloadPrompt, DownloadModal, UserAvatar } from '@/components';
import { formatTimeDifference, avatarSrc } from '@/lib';

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const tweetStore = useTweetStore()
const alertStore = useAlertStore()
const isLoggedIn = computed(() => !!tweetStore.loginUser)

const emit = defineEmits<{ (e: 'refresh'): void }>()

/** Logo: on home feed as a logged-in user -> self profile; anywhere else -> home. */
function onAppAvatarClick() {
    if (route.name !== 'main') {
        router.push({ name: 'main' })
        return
    }
    const loginUserId = tweetStore.loginUser?.mid
    if (loginUserId) {
        router.push({ name: 'UserPage', params: { authorId: loginUserId } })
        return
    }
    emit('refresh')
}
const isAccountMenuOpen = ref(false)
let accountMenuCloseTimer: ReturnType<typeof setTimeout> | null = null
const props = defineProps({
    userId: { type: String, required: false },
})
const userId = computed(() => props.userId)
const avatarUrl = ref(import.meta.env.VITE_APP_LOGO)
const user = ref<User>()
const isAccountAvatarBroken = ref(false)
const accountAvatarSrc = computed(() =>
    isLoggedIn.value && !isAccountAvatarBroken.value ? avatarSrc(tweetStore.loginUser?.avatar) : undefined
)

/** Bold name in profile header — use username when display name is missing (same as ItemHeader). */
const profileHeaderDisplayName = computed(() => {
    const u = user.value
    if (!u) return ''
    const name = u.name
    if (name != null && String(name).trim() !== '') return name
    const un = u.username
    if (un != null && String(un).trim() !== '') return un
    return ''
})

/** Profile header follow: same source as UserRow — `getFollowings(loginUser)` (not store.followings / guest seed). */
const FOLLOW_PROFILE_DEBOUNCE_MS = 600
const loginFollowingIds = ref<MimeiId[]>([])
const localIsFollowing = ref(false)
const isTogglingProfileFollow = ref(false)
let profileFollowCooldownUntil = 0

const canShowProfileFollowBtn = computed(
    () =>
        isLoggedIn.value &&
        !!user.value &&
        !!tweetStore.loginUser &&
        user.value.mid !== tweetStore.loginUser.mid,
)

function syncFollowButtonFromServerList() {
    const id = userId.value
    if (!id || !tweetStore.loginUser || id === tweetStore.loginUser.mid) {
        localIsFollowing.value = false
        return
    }
    localIsFollowing.value = loginFollowingIds.value.includes(id)
}

async function refreshLoginFollowingIds() {
    if (!tweetStore.loginUser) {
        loginFollowingIds.value = []
        syncFollowButtonFromServerList()
        return
    }
    try {
        loginFollowingIds.value = await tweetStore.getFollowings(tweetStore.loginUser.mid)
    } catch (e) {
        console.warn('[AppHeader] refreshLoginFollowingIds failed', e)
        loginFollowingIds.value = []
    }
    syncFollowButtonFromServerList()
}

watch(
    () => [userId.value, tweetStore.loginUser?.mid] as const,
    () => {
        void refreshLoginFollowingIds()
    },
    { immediate: true },
)

async function onProfileToggleFollow(event: Event) {
    event.preventDefault()
    event.stopPropagation()
    if (!user.value || !tweetStore.loginUser || isTogglingProfileFollow.value) return
    const now = Date.now()
    if (now < profileFollowCooldownUntil) return
    profileFollowCooldownUntil = now + FOLLOW_PROFILE_DEBOUNCE_MS

    const previous = localIsFollowing.value
    localIsFollowing.value = !previous
    isTogglingProfileFollow.value = true
    try {
        const nextState = await tweetStore.toggleFollowing(user.value.mid)
        localIsFollowing.value = nextState
        const id = user.value.mid
        if (nextState && !loginFollowingIds.value.includes(id)) {
            loginFollowingIds.value = [...loginFollowingIds.value, id]
        } else if (!nextState) {
            loginFollowingIds.value = loginFollowingIds.value.filter((x) => x !== id)
        }
    } catch (error) {
        localIsFollowing.value = previous
        console.error('Failed to toggle following:', error, { mid: user.value?.mid, username: user.value?.username })
        alertStore.error(t('profile.followActionFailed'))
    } finally {
        isTogglingProfileFollow.value = false
        profileFollowCooldownUntil = Math.max(profileFollowCooldownUntil, Date.now() + FOLLOW_PROFILE_DEBOUNCE_MS)
    }
}

// App download prompt and modal
const showDownloadPrompt = ref(false)
const showDownloadModal = ref(false)
const isDownloading = ref(false)
const appVersion = ref<number | null>(null)

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

    const pageSize = 5
    const maxPages = 4
    let originalTweetCount = 0

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        const response = await user.client.RunMApp("get_tweets_by_user", {
            aid: tweetStore.appId,
            ver: "last",
            version: "v2",
            userid: userId,
            pn: pageNumber,
            ps: pageSize,
            appuserid: userId,
        })

        if (response?.success !== true) {
            break
        }
        const body =
            response.data != null && typeof response.data === 'object' && !Array.isArray(response.data)
                ? response.data
                : response
        if (!Array.isArray(body.tweets)) {
            break
        }

        const tweets = body.tweets.filter((tweet: any) => tweet != null)
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

const uploadTweet = async () => {
    closeAccountMenu()
    const loginUser = tweetStore.loginUser
    const hasValidCloudDrivePort = isValidCloudDrivePort(loginUser?.cloudDrivePort)

    // If cloudDrivePort is valid, always navigate directly to editor.
    if (hasValidCloudDrivePort) {
        router.push({ name: 'post' })
        return
    }

    if (loginUser?.mid) {
        try {
            const originalTweetCount = await countOriginalTweetsByUser(loginUser.mid)

            if (originalTweetCount >= 5 && !hasValidCloudDrivePort) {
                router.push({ name: 'leitherSetupNotice' })
                return
            }
        } catch (error) {
            console.error('[publish pre-check] Failed to validate original tweet threshold for user:', loginUser.mid, error)
        }
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

onMounted(async () => {
    setTimeout(() => {
        showDownloadPrompt.value = true
    }, 2000)

    setTimeout(() => {
        showDownloadPrompt.value = false
    }, 30000)

    const cached = sessionStorage.getItem('appVersion')
    if (cached) appVersion.value = Number(cached)

    try {
        const res = await tweetStore.lapi.client.RunMApp("check_upgrade", {
            aid: tweetStore.appId,
            ver: "last",
            version: "v2",
        })
        const data = res?.success ? res.data : res
        if (data?.version != null) {
            appVersion.value = data.version
            sessionStorage.setItem('appVersion', String(data.version))
        }
    } catch (e) {
        console.warn('[AppHeader] check_upgrade failed', e)
    }
})
watch(
    userId,
    async (nv) => {
        if (!nv) {
            user.value = undefined
            return
        }
        const requestedId = nv
        const syncPeek =
            (tweetStore.loginUser?.mid === requestedId ? tweetStore.loginUser : undefined) ??
            tweetStore.users.get(requestedId)
        if (syncPeek) {
            user.value = syncPeek
        } else if (user.value?.mid !== requestedId) {
            user.value = undefined
        }
        try {
            // Use cache when available — racing provider IPs on every profile
            // visit was wasteful. If the cached IP is dead, the avatar's
            // @error handler force-refreshes to recover (see onAvatarError).
            const u = await tweetStore.getUserFromRootHost(requestedId)
            if (userId.value !== requestedId) return
            user.value = u ?? syncPeek
        } catch (e) {
            console.warn('[AppHeader] getUser failed', e)
            if (userId.value !== requestedId) return
            if (syncPeek) user.value = syncPeek
        }
    },
    { immediate: true },
)

/** Active profile view tab — covers all five stat tabs.
 *  Fans/followings are separate routes; tweets/bookmarks/favorites are
 *  ?view= variants of UserPage. */
const activeView = computed<'fans' | 'followings' | 'tweets' | 'bookmarks' | 'favorites'>(() => {
    if (route.name === 'followers') return 'fans'
    if (route.name === 'followings') return 'followings'
    const v = route.query.view
    return v === 'bookmarks' || v === 'favorites' ? v : 'tweets'
})

function setView(view: 'bookmarks' | 'favorites' | undefined) {
    const u = userId.value
    if (!u) return
    const query = view ? { view } : {}
    router.replace({ path: `/author/${u}`, query })
}

/** Bookmarks / Favorites lists are personal to the appUser — only show
 *  the tabs (and the corresponding tweet feeds) on the self-profile.
 *  Matches iOS ProfileStatsView. */
const isViewingSelf = computed(
    () => !!tweetStore.loginUser && !!user.value && user.value.mid === tweetStore.loginUser.mid
)

/** Cached avatar URLs can point at a now-dead provider IP. On image load
 *  failure, force a fresh getUser; _rewriteUserMediaHosts swaps the host
 *  on the live User object and the <img> reloads automatically. */
function onAvatarError(event: Event) {
    const img = event.target as HTMLImageElement | null
    if (!img || img.dataset.refreshed === '1') return
    const id = userId.value
    if (!id) return
    img.dataset.refreshed = '1'
    tweetStore.getUserFromRootHost(id, true).catch(() => undefined)
}

let avatarErrorRetries = 0
watch(() => tweetStore.loginUser?.avatar, () => {
    isAccountAvatarBroken.value = false
    avatarErrorRetries = 0
})

async function onAccountAvatarError() {
    isAccountAvatarBroken.value = true
    const id = tweetStore.loginUser?.mid
    if (!id || avatarErrorRetries >= 1) return
    avatarErrorRetries++
    await tweetStore.getUserFromRootHost(id, true).catch(() => undefined)
    // Force a reload attempt even when the URL hasn't changed (e.g. the writable
    // host background resolution in login() may now have fixed it).
    isAccountAvatarBroken.value = false
}
</script>

<template>
    <div class="mb-1">
        <div class="header-row">
            <div class="header-left">
                <div class="avatar me-2 ms-2 mt-1">
                    <UserAvatar v-if="user" :user="user" @click="onAppAvatarClick" @error="onAvatarError" alt="User Avatar"
                        class="rounded-circle" />
                    <img v-else :src="avatarUrl" @click="onAppAvatarClick" @error="onAvatarError" alt="Logo"
                        class="rounded-circle" />
                </div>
                <!-- User Info -->
                <div v-if="user" class="user-info flex-grow-1">
                    <!-- Username, Alias, and Time -->
                    <div class="username-alias-time">
                        <span class="username fw-bold">{{ profileHeaderDisplayName }}</span>
                        <span class="alias text-muted">@{{ user.username }}</span>
                        <span class="time text-muted">
                            - {{ formatTimeDifference(user.timestamp as number) }}
                        </span>
                    </div>

                    <div class="profile-bio">
                        <span class="alias text-muted">{{ user.profile }}</span>
                    </div>
                </div>
                <!-- Container for the link when no user -->
                <div v-else class="no-user-container">
                    <a href="http://tweet.fireshare.us">HTTP://tweet.fireshare.us</a>
                </div>
            </div>
            <div
                class="account-menu-wrapper"
                @mouseenter="openAccountMenu"
                @mouseleave="scheduleCloseAccountMenu"
            >
                <a
                    href="#"
                    class="account-btn"
                    @click.prevent="isAccountMenuOpen = !isAccountMenuOpen"
                    :title="isLoggedIn ? $t('auth.account') : $t('auth.login')"
                    :aria-expanded="isAccountMenuOpen"
                    aria-haspopup="true"
                >
                    <UserAvatar v-if="accountAvatarSrc && tweetStore.loginUser" :user="tweetStore.loginUser" :src="accountAvatarSrc"
                        class="account-avatar rounded-circle"
                        @error="onAccountAvatarError" />
                    <svg v-else xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="account-icon-fallback">
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
                    <div v-if="appVersion !== null" class="account-dropdown-version">v{{ appVersion }}</div>
                </div>
            </div>
        </div>
        <!-- Followers and Friends Links -->
        <div v-if="user" class="user-actions">
            <div v-if="user" class="links">
                <a href="#" class="text-muted view-tab" :class="{ active: activeView === 'fans' }"
                    @click.prevent="router.push(`/followers/${user.mid}`)">{{
                    user.followersCount }} {{ $t('profile.fans') }}</a>
                <a href="#" class="text-muted view-tab" :class="{ active: activeView === 'followings' }"
                    @click.prevent="router.push(`/followings/${user.mid}`)">{{
                    user.followingCount }} {{ $t('profile.following') }}</a>
                <a href="#" class="text-muted view-tab" :class="{ active: activeView === 'tweets' }"
                    @click.prevent="setView(undefined)">{{ user.tweetCount }} {{ $t('profile.tweet') }}</a>

                <!-- Bookmarks / Favorites are personal: appUser only. -->
                <template v-if="isViewingSelf">
                    <a href="#" class="text-muted view-tab" :class="{ active: activeView === 'bookmarks' }"
                        @click.prevent="setView('bookmarks')">{{ user.bookmarksCount ?? 0 }} {{ $t('profile.bookmarks') }}</a>
                    <a href="#" class="text-muted view-tab" :class="{ active: activeView === 'favorites' }"
                        @click.prevent="setView('favorites')">{{ user.favoritesCount ?? 0 }} {{ $t('profile.favorites') }}</a>
                </template>
            </div>
            <button
                v-if="canShowProfileFollowBtn"
                type="button"
                class="profile-follow-btn"
                :class="{ 'is-following': localIsFollowing }"
                :disabled="isTogglingProfileFollow"
                @click="onProfileToggleFollow"
            >
                {{ localIsFollowing ? $t('profile.unfollow') : $t('profile.follow') }}
            </button>
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
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: nowrap;
    min-height: 68px;
    margin: 0;
    padding: 10px 10px 4px 0;
}

.header-left {
    display: flex;
    align-items: flex-start;
    flex: 1;
    min-width: 0;
    padding-right: 0px;
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
    margin-left: 4px;
    /* Adds some space between avatar and user info */
    flex-wrap: wrap;
    /* Allows text to wrap on smaller screens */
    min-width: 0;
    padding-top: 2px;
}

.username-alias-time {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    /* Allows text to wrap on smaller screens */
    font-size: 0.95rem;
    color: #ccd0d4;
    margin-bottom: 6px;
    line-height: 1.25;
}

.profile-bio {
    line-height: 1.35;
    padding-right: 6px;
}

.profile-bio .alias {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.text-muted {
    font-size: 0.95rem;
    color: #ccd0d4 !important;
}

.user-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding-top: 8px;
    padding-bottom: 1px;
}

.links {
    padding-left: 10px;
    display: flex;
    flex: 1;
    min-width: 0;
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

.links a.view-tab.active {
    color: #1d9bf0 !important;
    font-weight: 600;
}

.profile-follow-btn {
    flex-shrink: 0;
    border: 1px solid #0d6efd;
    border-radius: 999px;
    background: transparent;
    color: #0d6efd;
    font-size: 0.85rem;
    font-weight: 500;
    min-width: 88px;
    padding: 5px 18px 5px 12px;
    margin-right: 10px;
    line-height: 1;
    transition: opacity 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.profile-follow-btn.is-following {
    border-color: #dc3545;
    color: #dc3545;
}

.profile-follow-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
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
        margin-left: 4px;
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
        min-height: 68px;
        padding-top: 10px;
    }

    .account-menu-wrapper {
        margin-left: 10px;
        margin-right: 8px;
    }
}

@media (min-width: 1200px) {
    .user-info {
        margin-left: 6px;
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
    box-sizing: border-box;
    min-width: 24px;
    min-height: 24px;
    padding: 0;
    text-decoration: none;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
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

.account-icon-fallback {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
}

.account-menu-wrapper {
    position: relative;
    flex-shrink: 0;
    padding-bottom: 2px;
    margin-bottom: -2px;
    margin-left: 12px;
    margin-top: 8px;
    margin-right: 10px;
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

.account-dropdown-version {
    padding: 6px 12px;
    color: #aaa;
    font-size: 0.78rem;
    text-align: right;
    border-top: 1px solid #e6ecf0;
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
