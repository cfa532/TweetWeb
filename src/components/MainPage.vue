<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useTweetStore } from "@/stores";
import { TweetView, AppHeader } from "@/views"
import { storeToRefs } from 'pinia';

const tweetStore = useTweetStore();
const tweetStoreRefs = storeToRefs(tweetStore)
const sorted = computed(()=>{
    return tweetStoreRefs.tweets.value.sort((a, b) => {
        return (b.timestamp as number) - (a.timestamp as number);
      });
})
const isLoading = ref(false)
onMounted(async ()=> {
    if (sessionStorage["isBot"] != "No") {
        confirm("Download App for more.") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
    isLoading.value = true
    await tweetStore.loadTweets()
    isLoading.value = false
})
</script>

<template>
    <AppHeader />
    <TweetView v-for="(tweet, index) in sorted" :tweet="tweet" :key="index" />
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</template>

<style scoped>
</style>