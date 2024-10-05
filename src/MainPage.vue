<script setup lang="ts">
import { onMounted } from 'vue';
import { useTweetListStore } from "@/stores/tweetStore";
import { TweetView } from "@/views"
import { storeToRefs } from 'pinia';

const tweetStore = useTweetListStore();
const tweetStoreRefs = storeToRefs(tweetStore)

onMounted(()=> {
    console.log("Mainpage")
    tweetStore.loadTweets()
})
</script>

<template>
    <TweetView v-for="(tweet, index) in tweetStoreRefs.tweets.value" :tweet="tweet" :key="index" />
</template>

<style scoped>
</style>