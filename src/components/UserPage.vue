<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";
import { TweetView, AppHeader } from "@/views"

const route = useRoute();
const authorId = route.params.authorId as string
const tweetStore = useTweetStore();
const isLoading = ref(false)

onMounted(async () => {
    isLoading.value = true
    await tweetStore.loadTweets(authorId)
    isLoading.value = false

    window.setTimeout(()=>{
    }, 3000)
})

</script>

<template>
    <AppHeader :userId=authorId />
    <TweetView v-for="tweet in tweetStore.tweets.filter(e=>e.authorId==authorId)" :tweet="tweet" :key="tweet.mid" />
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</template>

<style scoped>
</style>