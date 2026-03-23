<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTweetStore } from '@/stores'
import { useRoute } from 'vue-router';
import { AppHeader, UserRow } from "@/views";
import { LoadingSpinner, PageLayout } from "@/components";
import { LOAD_TIMEOUT_MS, MAX_REFRESH_ATTEMPTS } from '@/constants';

const { t } = useI18n();
const route = useRoute();
const userId = route.params.userId as MimeiId
const tweetStore = useTweetStore()
const followingIds = ref([] as MimeiId[])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const currentIndex = ref(0)
const batchSize = 15 // Number of users to load at once
const containerRef = ref<HTMLElement>()

// Computed property for currently visible user IDs
const visibleUserIds = computed(() => {
    return followingIds.value.slice(0, currentIndex.value)
})

// Check if there are more users to load
const hasMoreUsers = computed(() => {
    return currentIndex.value < followingIds.value.length
})

// Load the next batch of user IDs
const loadNextBatch = async () => {
    if (isLoadingMore.value || !hasMoreUsers.value) return
    
    isLoadingMore.value = true
    const endIndex = Math.min(currentIndex.value + batchSize, followingIds.value.length)
    
    // Simply update the current index to show more user IDs
    currentIndex.value = endIndex
    isLoadingMore.value = false
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
        // Load all following IDs with timeout, refresh immediately on timeout (max attempts)
        const refreshCount = parseInt(sessionStorage.getItem('followingsRefreshCount') || '0')

        let timeoutId: number | null = null;
        const loadPromise = tweetStore.getFollowings(userId)
        const timeoutPromise = new Promise<never>((_, reject) =>
            timeoutId = window.setTimeout(() => {
                if (refreshCount < MAX_REFRESH_ATTEMPTS) {
                    console.warn(`Followings load timeout after ${LOAD_TIMEOUT_MS}ms, refreshing page (${refreshCount + 1}/${MAX_REFRESH_ATTEMPTS})`)
                    sessionStorage.setItem('followingsRefreshCount', (refreshCount + 1).toString())
                    isLoading.value = false
                    window.location.reload()
                } else {
                    console.warn(`Max refresh attempts (${MAX_REFRESH_ATTEMPTS}) reached for Followings, stopping`)
                    isLoading.value = false
                    sessionStorage.removeItem('followingsRefreshCount')
                }
                reject(new Error('Followings load timeout'))
            }, LOAD_TIMEOUT_MS)
        )

        followingIds.value = await Promise.race([loadPromise, timeoutPromise])
        // Success - clear the timeout
        if (timeoutId) clearTimeout(timeoutId)
        isLoading.value = false
        sessionStorage.removeItem('followingsRefreshCount') // Clear on success

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
            // Load followings with 6-second timeout, refresh immediately on timeout (max 5 refreshes)
            const refreshCount = parseInt(sessionStorage.getItem('followingsRefreshCount') || '0')

            let timeoutId: number | null = null;
            const loadPromise = tweetStore.getFollowings(newUserId as MimeiId)
            const timeoutPromise = new Promise<never>((_, reject) =>
                timeoutId = window.setTimeout(() => {
                    if (refreshCount < 3) {
                        console.warn(`Followings load timeout after 15 seconds, refreshing page (${refreshCount + 1}/3)`)
                        sessionStorage.setItem('followingsRefreshCount', (refreshCount + 1).toString())
                        isLoading.value = false
                        window.location.reload()
                    } else {
                        console.warn('Max refresh attempts (3) reached for Followings, stopping')
                        isLoading.value = false
                        sessionStorage.removeItem('followingsRefreshCount')
                    }
                    reject(new Error('Followings load timeout'))
                }, 15000) // 15 seconds
            )

            const newIds = await Promise.race([loadPromise, timeoutPromise])
            // Success - clear the timeout
            if (timeoutId) clearTimeout(timeoutId)
            followingIds.value = newIds
            isLoading.value = false
            sessionStorage.removeItem('followingsRefreshCount') // Clear on success

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

// Cleanup on component unmount
import { onUnmounted } from 'vue'
onUnmounted(() => {
    cleanup()
})
</script>

<template>
    <PageLayout width="normal">
        <AppHeader :userId="userId"/>

        <div ref="containerRef" class="users-container">
        <UserRow 
            v-for="userId in visibleUserIds" 
            :userId="userId" 
            :key="userId" 
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
    padding: 10px;
    background-color: #f9f9f9;
    transition: background-color 0.3s ease;
}

.user-row:hover {
    background-color: #e9e9e9;
}
</style>