<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";
import { TweetView, AppHeader } from "@/views"

const route = useRoute();
const authorId = route.params.authorId as string
const tweetStore = useTweetStore();
const isLoading = ref(false)

onMounted(()=> {
    isLoading.value = true
    tweetStore.loadTweets(authorId)
    window.setTimeout(()=>{
        isLoading.value = false
    }, 3000)
})
</script>

<template>
    <AppHeader />
    <TweetView v-for="(tweet, index) in tweetStore.tweets" :tweet="tweet" :key="index" />
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</template>

<style scoped>
</style>