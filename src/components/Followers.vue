<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useTweetStore, useLeitherStore } from '@/stores'
import { useRoute } from 'vue-router';
import { ItemHeader } from "@/views";

const route = useRoute();
const userId = route.params.userId as MimeiId
const tweetStore = useTweetStore()
const followers = ref([] as User[])
const isLoading = ref(false)

onMounted(async () => {
    isLoading.value = true
    followers.value = await tweetStore.getFollowers(userId)
    isLoading.value = false
})
</script>
<template>
    <AppHeader />
    <ItemHeader v-for="user in followers" :tweet="tweet" :key="tweet.mid" />
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</template>
<style scoped>
</style>