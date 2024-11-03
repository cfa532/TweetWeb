<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useTweetStore } from "@/stores";
import { TweetView, AppHeader } from "@/views"

const tweetStore = useTweetStore();
const isLoading = ref(false)

onMounted(async ()=> {
    if (sessionStorage["isBot"] != "No") {
        confirm("Download App for more.") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
    isLoading.value = true
    await tweetStore.loadTweets()
    window.setTimeout(()=>{
        isLoading.value = false
    }, 3000)
})
</script>

<template>
    <AppHeader />
    <TweetView v-for="tweet in tweetStore.tweets" :tweet="tweet" :key="tweet.mid" />
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</template>

<style scoped>
</style>