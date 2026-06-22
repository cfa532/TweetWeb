<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
defineOptions({ name: 'Followings' })
import { useI18n } from 'vue-i18n'
import { useTweetStore } from '@/stores'
import { useRoute } from 'vue-router';
import { AppHeader, UserRow } from "@/views";
import { LoadingSpinner, PageLayout } from "@/components";
import { LOAD_TIMEOUT_MS } from '@/constants';
import { useScrollRestore } from '@/composables/useScrollRestore';

const { t } = useI18n();
const route = useRoute();
// Reactive so the AppHeader updates when navigating followings/A → followings/B
// within this same keep-alive instance. loadedUserId tracks what's currently
// rendered so the watcher can detect an actual change.
const userId = computed(() => route.params.userId as MimeiId)
const loadedUserId = ref<MimeiId | undefined>(userId.value)
const tweetStore = useTweetStore()
const followingIds = ref([] as MimeiId[])
const loginFollowingIds = ref([] as MimeiId[])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const currentIndex = ref(0)
const batchSize = 8 // Number of users to load at once
                    // (kept small so the connection pool isn't saturated by
                    //  dozens of parallel getUser calls; subsequent batches
                    //  auto-load as soon as the current one resolves)

// Computed property for currently visible user IDs
const visibleUserIds = computed(() => {
    return followingIds.value.slice(0, currentIndex.value)
})

// Check if there are more users to load
const hasMoreUsers = computed(() => {
    return currentIndex.value < followingIds.value.length
})

const isLoggedIn = computed(() => !!tweetStore.loginUser)

// Load the next batch of user IDs.
//
// Kick off pre-fetches for the batch in parallel, then reveal the rows
// IMMEDIATELY so each UserRow renders a placeholder right away. Each
// UserRow's own onMounted getUser call is deduped via tweetStore's
// _pendingUserFetches map (in-flight at this point), so it shares the
// same promise — one network call per user, and each row updates as
// soon as its individual data lands (no waiting for the whole batch).
//
// The await on Promise.allSettled gates the next batch so we don't
// pile on the connection pool. After the batch settles, recurse to
// load the next one — keeps loading continuously until every following
// is mounted. Paused while scroll is being restored so useScrollRestore
// can page content in deterministically.
const loadNextBatch = async () => {
    if (isLoadingMore.value || !hasMoreUsers.value) return

    isLoadingMore.value = true
    const endIndex = Math.min(currentIndex.value + batchSize, followingIds.value.length)
    const idsToLoad = followingIds.value.slice(currentIndex.value, endIndex)

    // Start fetches FIRST so they're registered in _pendingUserFetches
    // before UserRow's onMounted runs and looks them up.
    const fetches = idsToLoad.map(id => tweetStore.getUser(id).catch(() => undefined))

    // Reveal the rows now — UserRow placeholders mount and dedup with
    // the in-flight fetches above.
    currentIndex.value = endIndex

    // Gate next batch on this batch settling.
    await Promise.allSettled(fetches)

    isLoadingMore.value = false

    if (hasMoreUsers.value && !isRestoringFeed.value) {
        // Auto-continue without waiting for scroll.
        loadNextBatch()
    }
}

// Infinite scroll on the window (same model as MainPage/UserPage).
const handleScroll = () => {
    if (isRestoringFeed.value || isLoadingMore.value || !hasMoreUsers.value) return
    const scrollBottom = window.innerHeight + window.scrollY
    const docHeight = document.documentElement.scrollHeight
    if (docHeight - scrollBottom <= 200) {
        loadNextBatch()
    }
}

// Persist & restore this list's scroll position, keyed per-user so one user's
// spot never bleeds onto another's. Back-nav restores synchronously (keep-alive
// DOM); reload pages content in then jumps. See composables/useScrollRestore.
const { restoring: isRestoringFeed, restoreAfterLoad } = useScrollRestore(
    () => `followings:${route.params.userId}`,
    { hasMore: () => hasMoreUsers.value, loadMore: loadNextBatch },
)

async function loadFollowings(targetUserId: MimeiId) {
    isLoading.value = true

    try {
        if (tweetStore.loginUser) {
            loginFollowingIds.value = await tweetStore.getFollowings(tweetStore.loginUser.mid)
        } else {
            loginFollowingIds.value = []
        }

        // Load all following IDs with timeout. On timeout show empty state instead
        // of reloading the page (the reload was disruptive and didn't fix anything).
        let timeoutId: number | null = null;
        const loadPromise = tweetStore.getFollowings(targetUserId)
        const timeoutPromise = new Promise<MimeiId[]>((resolve) =>
            timeoutId = window.setTimeout(() => {
                console.warn('[Followings] load timeout; showing empty state')
                resolve([])
            }, LOAD_TIMEOUT_MS)
        )

        followingIds.value = await Promise.race([loadPromise, timeoutPromise])
        // Success - clear the timeout
        if (timeoutId) clearTimeout(timeoutId)
        isLoading.value = false

        // Load the first batch of users
        if (followingIds.value.length > 0) {
            await loadNextBatch()
        }
    } catch (error) {
        console.error('Unexpected error loading followings:', error)
    }
}

onMounted(async () => {
    await loadFollowings(userId.value)
    await restoreAfterLoad()
    // Resume auto-loading any remaining batches now that scroll position is set.
    if (hasMoreUsers.value) loadNextBatch()
    window.addEventListener('scroll', handleScroll, { passive: true })
})

// Reload when the :userId param changes (same keep-alive instance).
watch(() => route.params.userId, async (newUserId) => {
    if (!newUserId || newUserId === loadedUserId.value) return
    cleanup()
    followingIds.value = []
    currentIndex.value = 0
    await loadFollowings(newUserId as MimeiId)
    loadedUserId.value = newUserId as MimeiId
    await restoreAfterLoad()
    if (hasMoreUsers.value) loadNextBatch()
    window.addEventListener('scroll', handleScroll, { passive: true })
})

function handleFollowToggled(payload: { userId: MimeiId; isFollowing: boolean }) {
    const exists = loginFollowingIds.value.includes(payload.userId)
    if (payload.isFollowing && !exists) {
        loginFollowingIds.value = [...loginFollowingIds.value, payload.userId]
    } else if (!payload.isFollowing && exists) {
        loginFollowingIds.value = loginFollowingIds.value.filter(id => id !== payload.userId)
    }
}

function handleResolveFailed(userId: MimeiId) {
    followingIds.value = followingIds.value.filter(id => id !== userId)
}

// Cleanup scroll listener
function cleanup() {
    window.removeEventListener('scroll', handleScroll)
}
onUnmounted(() => {
    cleanup()
})
</script>

<template>
    <PageLayout>
        <AppHeader :userId="userId"/>

        <!-- The list is part of the normal window scroll, so the header scrolls
             with it — same as every other screen. -->
        <div class="users-list" :class="{ 'list-restoring': isRestoringFeed }">
            <UserRow
                v-for="userId in visibleUserIds"
                :userId="userId"
                :isFollowing="loginFollowingIds.includes(userId)"
                :showFollowButton="isLoggedIn"
                :key="userId"
                @follow-toggled="handleFollowToggled"
                @resolve-failed="handleResolveFailed"
                class="user-row"
            />

            <!-- Loading spinner for initial load -->
            <div v-if="isLoading" class="d-flex justify-content-center my-3">
                <LoadingSpinner />
            </div>

            <!-- Loading spinner for more users -->
            <div v-if="isLoadingMore && !isLoading" class="d-flex justify-content-center my-3">
                <LoadingSpinner size="sm" />
            </div>

            <!-- End of list indicator -->
            <div v-if="!hasMoreUsers && visibleUserIds.length > 0" class="text-center text-muted my-3">
                <small>{{ $t('tweet.noMoreUsers') }}</small>
            </div>

            <!-- Empty state -->
            <div v-if="!isLoading && followingIds.length === 0" class="text-center text-muted my-3">
                <small>{{ $t('tweet.noUsersFound') }}</small>
            </div>
        </div>

        <div v-if="isRestoringFeed" class="list-restoring-overlay" aria-live="polite">
            <LoadingSpinner />
        </div>
    </PageLayout>
</template>

<style scoped>
/* Inset the row boxes from the screen edges (both sides) and add a little gap
   below the header. */
.users-list {
    padding: 8px 8px 0px;
}

.user-row {
    border: 1px solid #ccc;
    border-radius: 5px;
    margin: 5px 0px;
    padding: 10px 6px;
    background-color: #f9f9f9;
    transition: background-color 0.3s ease;
}

.user-row:hover {
    background-color: #e9e9e9;
}

/* While paging in content to reach a saved scroll offset (deep reload), keep the
   list's layout for measurement but hide it so the top never flashes. */
.list-restoring {
    visibility: hidden;
}

.list-restoring-overlay {
    position: fixed;
    inset: 0;
    z-index: 1030;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.8);
}
</style>
