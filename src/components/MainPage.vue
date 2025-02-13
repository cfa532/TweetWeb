<script setup lang='ts'>
import { computed, onMounted, ref, onUnmounted } from 'vue';
import { useTweetStore } from '@/stores';
import { TweetView, AppHeader } from '@/views'

const SEVEN_DAYS = 604800000;
const tweetStore = useTweetStore();
const isLoading = ref(false);
const lastLoadTime = ref(new Date().getTime()); // Use ref for reactivity
const endTime = ref(lastLoadTime.value - SEVEN_DAYS*4);
const scrollThreshold = 200; // Distance from bottom to trigger load
const initialLoad = ref(true);

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
    await tweetStore.loadTweets(undefined, lastLoadTime.value, endTime.value);
    lastLoadTime.value = endTime.value;
    endTime.value -= SEVEN_DAYS;
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
            await loadTweets()
        } else {
            history.go(-1)
        }
    } else {
        await loadTweets()
    }
    window.addEventListener('scroll', handleScroll);
});

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll);
});

async function loadTweets() {
    if (isLoading.value)
        return; // Prevent multiple loads
    isLoading.value = true;
    let attempts = 0; // Add an attempts counter
    const maxAttempts = 10; // Set a maximum number of attempts

    await tweetStore.loadTweets(undefined, lastLoadTime.value, endTime.value);
    lastLoadTime.value = endTime.value;
    endTime.value -= SEVEN_DAYS;    // go back 7 days

    while (tweetFeed.value.length < 4 && attempts < maxAttempts && initialLoad.value) 
    {
        attempts++;
        await tweetStore.loadTweets(undefined, lastLoadTime.value, endTime.value);
        lastLoadTime.value = endTime.value;
        endTime.value -= SEVEN_DAYS;
    }
    initialLoad.value = false;

    window.setTimeout(() => {
        isLoading.value = false;
    }, 2000);
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