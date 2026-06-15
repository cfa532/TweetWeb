<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTweetStore } from '@/stores'
import { useRoute } from 'vue-router';
import { AppHeader, UserRow } from "@/views";
import { LoadingSpinner, PageLayout } from "@/components";
import { LOAD_TIMEOUT_MS } from '@/constants';

const { t } = useI18n();
const route = useRoute();
const userId = route.params.userId as MimeiId
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
const containerRef = ref<HTMLElement>()

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
// is mounted.
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

    if (hasMoreUsers.value) {
        // Auto-continue without waiting for scroll.
        loadNextBatch()
    }
}

// Handle scroll to load more users
const handleScroll = () => {
    if (!containerRef.value) return
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.value
    const scrollPercentage = (scrollTop + clientHeight) / scrollHeight
    
    // Load more when user scrolls to 80% of the content
    if (scrollPercentage > 0.8 && hasMoreUsers.value && !isLoadingMore.value) {
        loadNextBatch()
    }
}

onMounted(async () => {
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
        const loadPromise = tweetStore.getFollowings(userId)
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

        // Add scroll listener
        if (containerRef.value) {
            containerRef.value.addEventListener('scroll', handleScroll)
        }
    } catch (error) {
        // Timeout already handled the refresh
        console.error('Unexpected error loading followings:', error)
    }
})

// Cleanup scroll listener
const cleanup = () => {
    if (containerRef.value) {
        containerRef.value.removeEventListener('scroll', handleScroll)
    }
}

// Watch for route changes to reset state
watch(() => route.params.userId, async (newUserId) => {
    if (newUserId !== userId) {
        cleanup()
        followingIds.value = []
        currentIndex.value = 0
        isLoading.value = true

        try {
            if (tweetStore.loginUser) {
                loginFollowingIds.value = await tweetStore.getFollowings(tweetStore.loginUser.mid)
            } else {
                loginFollowingIds.value = []
            }

            // Load followings with 15-second timeout; on timeout show empty list
            // rather than reloading.
            let timeoutId: number | null = null;
            const loadPromise = tweetStore.getFollowings(newUserId as MimeiId)
            const timeoutPromise = new Promise<MimeiId[]>((resolve) =>
                timeoutId = window.setTimeout(() => {
                    console.warn('[Followings] load timeout (route change); showing empty state')
                    resolve([])
                }, 15000)
            )

            const newIds = await Promise.race([loadPromise, timeoutPromise])
            // Success - clear the timeout
            if (timeoutId) clearTimeout(timeoutId)
            followingIds.value = newIds
            isLoading.value = false

            if (newIds.length > 0) {
                await loadNextBatch()
            }

            if (containerRef.value) {
                containerRef.value.addEventListener('scroll', handleScroll)
            }
        } catch (error) {
            // Timeout already handled the refresh
            console.error('Unexpected error loading followings on route change:', error)
        }
    }
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

// Cleanup on component unmount
import { onUnmounted } from 'vue'
onUnmounted(() => {
    cleanup()
})
</script>

<template>
    <PageLayout>
        <AppHeader :userId="userId"/>

        <div ref="containerRef" class="users-container">
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
    </PageLayout>
</template>

<style scoped>
.users-container {
    max-height: calc(100vh - 100px);
    overflow-y: auto;
    padding: 10px;
}

.user-row {
    border: 1px solid #ccc;
    border-radius: 5px;
    margin: 5px 0;
    padding: 10px 10px 10px 6px;
    background-color: #f9f9f9;
    transition: background-color 0.3s ease;
}

.user-row:hover {
    background-color: #e9e9e9;
}
</style>