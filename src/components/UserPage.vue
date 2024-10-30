<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";
import { TweetView, AppHeader } from "@/views"
import { storeToRefs } from 'pinia';

const route = useRoute();
const authorId = route.params.authorId as string
const tweetStore = useTweetStore();
const tweetStoreRefs = storeToRefs(tweetStore)
const sorted = computed(()=>{
    return tweetStoreRefs.tweets.value.sort((a, b) => {
        return (b.timestamp as number) - (a.timestamp as number);
      });
})
onMounted(()=> {
    console.log("userpage")
    tweetStore.loadTweets(authorId)
})
</script>

<template>
    <AppHeader />
    <TweetView v-for="(tweet, index) in sorted" :tweet="tweet" :key="index" />
</template>

<style scoped>
</style>