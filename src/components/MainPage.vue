<script setup lang='ts'>
import { computed, onMounted, ref, onUnmounted } from 'vue';
import { useTweetStore } from '@/stores';
import { TweetView, AppHeader } from '@/views'

const tweetStore = useTweetStore();
const isLoading = ref(false);
const scrollThreshold = 200; // Distance from bottom to trigger load
const initialLoad = ref(true);
const pageNumber = ref(0);
const pageSize = 30; // Using the same TWEET_COUNT constant from tweetStore

// Debounce function (you can also use a library like lodash)
function debounce<T extends Function>(func: T, delay: number) {
    let timeout: any;
    return function(this: any, ...args: any[]) { // Explicitly define 'this' type
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

async function loadMoreTweets() {
    if (isLoading.value)
        return; // Prevent multiple loads
    isLoading.value = true;
    pageNumber.value++;
    const tweetsLoaded = await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
    
    // If fewer tweets than requested were loaded, there are no more tweets
    if (tweetsLoaded < pageSize) {
        console.log('No more tweets available from backend');
        // Optionally, you could disable scroll loading here
    }
    
    isLoading.value = false;
}

const handleScroll = debounce(async () => {
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;

    if (documentHeight - scrollPosition < scrollThreshold) {
        await loadMoreTweets();
    }
}, 250); // Adjust debounce delay as needed

onMounted(async () => {
    if (sessionStorage['isBot'] != 'No') {
        if (confirm('芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!')) {
            sessionStorage['isBot'] = 'No'
            await loadTweetsWithMinimum()
        } else {
            history.go(-1)
        }
    } else {
        await loadTweetsWithMinimum()
    }
    window.addEventListener('scroll', handleScroll);
});

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll);
});

async function loadTweetsWithMinimum() {
    if (isLoading.value)
        return; // Prevent multiple loads
    isLoading.value = true;
    pageNumber.value = 0; // Reset page number for initial load
    
    // Load initial page
    const initialTweetsLoaded = await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
    
    // Keep loading more pages until we have at least 6 tweets or no more tweets
    const minTweets = 6;
    
    while (tweetStore.tweets.filter(e => !e.isPrivate).length < minTweets) {
        pageNumber.value++;
        const tweetsLoaded = await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
        
        // If fewer tweets than requested were loaded, there are no more tweets
        if (tweetsLoaded < pageSize) {
            console.log('No more tweets available from backend');
            break;
        }
    }
    
    isLoading.value = false;
    initialLoad.value = false;
}

async function loadTweets() {
    if (isLoading.value)
        return; // Prevent multiple loads
    isLoading.value = true;
    pageNumber.value = 0; // Reset page number for initial load
    await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
    isLoading.value = false;
    initialLoad.value = false;
}

const tweetFeed = computed(() => {
    return tweetStore.tweets.filter(e => !e.isPrivate);
});
</script>

<template>
    <div class='row justify-content-start align-items-start'>
        <div class='col-sm-12 col-md-8 col-lg-6' style='background-color:aliceblue;'>
            <AppHeader />
            <TweetView v-for='tweet in tweetFeed' :tweet='tweet' :key='tweet.mid' />
            <div v-if='isLoading' class='d-flex justify-content-center my-3'>
                <div class='spinner-border' role='status'>
                    <span class='visually-hidden'>Loading...</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
</style>