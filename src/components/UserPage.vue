<script setup lang='ts'>
import { computed, onMounted, ref, onUnmounted, watch } from 'vue';
import { useTweetStore } from '@/stores';
import { useRoute } from 'vue-router';
import { TweetView, AppHeader } from '@/views';

const tweetStore = useTweetStore();
const isLoading = ref(false);
const pageNumber = ref(0);
const scrollThreshold = 200; // Distance from bottom to trigger load
const route = useRoute();
const authorId = computed(() => route.params.authorId as MimeiId);
const pinnedTweets = ref<Tweet[]>([]);
const pageSize = 10; // Using the same page size as MainPage
const initialLoad = ref(true);

onMounted(async () => {
    tweetStore.removeUser(authorId.value);  // force reload user data from its host.
    await initialLoadTweets(authorId.value);
    console.log('UserPage mounted', await tweetStore.getUser(authorId.value));
    window.addEventListener('scroll', handleScroll);
    // Scroll to top when page is opened
    window.scrollTo(0, 0);
});

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll);
});

async function initialLoadTweets(authorId: MimeiId) {
    if (sessionStorage['isBot'] !== 'No') {
        if (confirm('芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!')) {
            sessionStorage['isBot'] = 'No';
            await loadTweetsWithMinimum(authorId);
        } else {
            history.go(-1);
        }
    } else {
        await loadTweetsWithMinimum(authorId);
    }
}

async function loadTweetsWithMinimum(authorId: MimeiId) {
    if (isLoading.value)
        return; // Prevent multiple loads
    isLoading.value = true;
    pageNumber.value = 0; // Reset page number for initial load
    
    // Load initial page
    await tweetStore.loadTweetsByUser(authorId, pageNumber.value, pageSize);
    
    // Keep loading more pages until we have at least 6 tweets or no more tweets
    const minTweets = 6;
    let tweetsLoaded = 0;
    let round = 0;
    
    while (isLoading.value && round < 10) {
        // Load initial page
        const loadedPageSize = await tweetStore.loadTweetsByUser(authorId, pageNumber.value, pageSize);
        if (loadedPageSize) {
            tweetsLoaded += loadedPageSize;
            round++;
        } else {
            console.warn("Init load failed. Cannot load tweets in round", round);
            break;
        }
        if (tweetsLoaded >= minTweets) {
            break;
        }
        
        // If fewer tweets than requested were loaded, there are no more tweets
        if (loadedPageSize < pageSize) {
            console.log('No more tweets available from backend. Page number:', pageNumber.value);
            break;
        } else {
            // Load next page
            pageNumber.value++;
            console.log('Loaded', tweetsLoaded, 'tweets. Page number:', pageNumber.value);
        }
    }
    
    // Load pinned tweets
    pinnedTweets.value = await tweetStore.loadPinnedTweets(authorId);
    pinnedTweets.value?.sort((a: any, b: any) => (b.timestamp as number) - (a.timestamp as number));
    
    isLoading.value = false;
    initialLoad.value = false;
}

async function loadMoreTweets() {
    if (isLoading.value) return; // Prevent multiple loads
    isLoading.value = true;
    const tweetsLoaded = await tweetStore.loadTweetsByUser(authorId.value, pageNumber.value, pageSize);
    
    // If fewer tweets than requested were loaded, there are no more tweets
    if (tweetsLoaded && tweetsLoaded < pageSize) {
        console.log('No more tweets available from backend');
        // Optionally, you could disable scroll loading here
    }
    pageNumber.value++;
    isLoading.value = false;
}

const tweetFeed = computed(() => {
    const filteredTweets = tweetStore.tweets.filter(e => {
        // Filter by author
        const isAuthorMatch = e.isPrivate 
            ? tweetStore.loginUser?.mid === e.authorId && e.authorId === authorId.value
            : e.authorId === authorId.value;
        
        // Filter out tweets that have originalTweetId but originalTweet is null
        const hasValidOriginalTweet = !e.originalTweetId || e.originalTweet !== null;
        
        return isAuthorMatch && hasValidOriginalTweet;
    });
    
    // Sort by timestamp in descending order (newest first)
    return filteredTweets.sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
});

watch(authorId, async (nv, ov) => {
    if (nv && nv !== ov) {
        pageNumber.value = 0; // Reset page number when loading new author's tweets
        await initialLoadTweets(nv);
        // Scroll to top when switching to a different author
        window.scrollTo(0, 0);
    }
});

// Debounce function (you can also use a library like lodash)
function debounce<T extends Function>(func: T, delay: number) {
    let timeout: any;
    return function (this: any, ...args: any[]) { // Explicitly define 'this' type
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

const handleScroll = debounce(async () => {
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;

    if (documentHeight - scrollPosition < scrollThreshold) {
        await loadMoreTweets();
    }
}, 250); // Adjust debounce delay as needed
</script>

<template>
    <div class='row justify-content-start align-items-start'>
        <div class='col-sm-12 col-md-8 col-lg-6' style='background-color:aliceblue;'>
            <AppHeader :userId='authorId' />
            <b v-if='pinnedTweets?.length!>0'>&nbsp;&nbsp;Pinned</b>
            <TweetView v-for='tweet in pinnedTweets' :tweet='tweet' :key='tweet.mid'/>
            <hr v-if='pinnedTweets?.length!>0' />
            <b v-if='pinnedTweets?.length!>0'>&nbsp;&nbsp;Tweets</b>
            <TweetView v-for='tweet in tweetFeed' :tweet='tweet' :key='tweet.mid'/>
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