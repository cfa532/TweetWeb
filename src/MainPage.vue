<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useTweetStore } from "@/stores/tweetStore";
import { TweetView } from "@/views"
import { storeToRefs } from 'pinia';

const tweetStore = useTweetStore();
const tweetStoreRefs = storeToRefs(tweetStore)
const sorted = computed(()=>{
    return tweetStoreRefs.tweets.value.slice().sort((a, b) => {
        return (b.timestamp as number) - (a.timestamp as number);
      });
})
onMounted(()=> {
    if (!sessionStorage["isBot"]) {
        confirm("Download App for more.") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
    tweetStore.loadTweets()
})
</script>

<template>
    <TweetView v-for="(tweet, index) in sorted" :tweet="tweet" :key="index" />
</template>

<style scoped>
</style>