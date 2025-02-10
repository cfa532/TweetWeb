<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useTweetStore } from "@/stores";
import { TweetView, AppHeader } from "@/views"

const tweetStore = useTweetStore();
const isLoading = ref(false)

onMounted(async () => {
    if (sessionStorage["isBot"] != "No") {
        if (confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!")) {
            sessionStorage["isBot"] = "No"
            loadTweets()
        } else {
            history.go(-1)
        }
    } else {
        loadTweets()
    }
})
async function loadTweets() {
    isLoading.value = true
    await tweetStore.loadTweets()
    window.setTimeout(() => {
        isLoading.value = false
    }, 2000)
}
const tweetFeed = computed(()=>{
    return tweetStore.tweets.filter(e => !e.isPrivate)
})
</script>

<template>
<div class="row justify-content-start align-items-start">
    <div class="col-sm-12 col-md-8 col-lg-6" style="background-color:aliceblue;">
        <AppHeader />
        <TweetView v-for="tweet in tweetFeed" :tweet="tweet" :key="tweet.mid" />
        <div v-if="isLoading" class="d-flex justify-content-center my-3">
            <div class="spinner-border" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    </div>
</div>
</template>

<style scoped>
</style>