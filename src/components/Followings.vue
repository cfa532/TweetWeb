<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useTweetStore } from '@/stores'
import { useRoute } from 'vue-router';
import { AppHeader, UserRow } from "@/views";

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
    
    // Load all following IDs first (this is fast)
    followingIds.value = await tweetStore.getFollowings(userId)
    
    isLoading.value = false
    
    // Load the first batch of users
    if (followingIds.value.length > 0) {
        await loadNextBatch()
    }
    
    // Add scroll listener
    if (containerRef.value) {
        containerRef.value.addEventListener('scroll', handleScroll)
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
        
        const newIds = await tweetStore.getFollowings(newUserId as MimeiId)
        followingIds.value = newIds
        isLoading.value = false
        
        if (newIds.length > 0) {
            await loadNextBatch()
        }
        
        if (containerRef.value) {
            containerRef.value.addEventListener('scroll', handleScroll)
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
            <div class="spinner-border" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
        
        <!-- Loading spinner for more users -->
        <div v-if="isLoadingMore && !isLoading" class="d-flex justify-content-center my-3">
            <div class="spinner-border spinner-border-sm" role="status">
                <span class="visually-hidden">Loading more...</span>
            </div>
        </div>
        
        <!-- End of list indicator -->
        <div v-if="!hasMoreUsers && visibleUserIds.length > 0" class="text-center text-muted my-3">
            <small>No more users to load</small>
        </div>
        
        <!-- Empty state -->
        <div v-if="!isLoading && followingIds.length === 0" class="text-center text-muted my-3">
            <small>No users found</small>
        </div>
    </div>
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