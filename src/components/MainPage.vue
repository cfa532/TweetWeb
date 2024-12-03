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
    }, 2000)

    // Get the current host and protocol
    const host = window.location.host;
    const protocol = window.location.protocol;

    // Construct the full URL for the icon
    const iconPath = '/mm/xmzaZPI_0CHL4hWGJukqC6yyGyW'; // Your relative path
    const fullIconUrl = `${protocol}//${host}${iconPath}`;

    // Set the href attribute of the link tag
    document.addEventListener('DOMContentLoaded', () => {
      const linkElement = document.querySelector("link[rel='icon']");
      if (linkElement) {
        (linkElement as HTMLLinkElement).href = fullIconUrl;
      }
    });
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