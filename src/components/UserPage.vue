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
const pageSize = 30; // Using the same page size as MainPage
const initialLoad = ref(true);

onMounted(async () => {
    await initialLoadTweets(authorId.value);
    window.addEventListener('scroll', handleScroll);
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
    await tweetStore.loadTweetsByRank(authorId, pageNumber.value, pageSize);
    
    // Keep loading more pages until we have at least 6 tweets or no more tweets
    const minTweets = 6;
    
    while (tweetFeed.value.length < minTweets) {
        pageNumber.value++;
        const tweetsLoaded = await tweetStore.loadTweetsByRank(authorId, pageNumber.value, pageSize);
        
        // If fewer tweets than requested were loaded, there are no more tweets
        if (tweetsLoaded < pageSize) {
            console.log('No more tweets available from backend');
            break;
        }
    }
    
    // Load pinned tweets
    pinnedTweets.value = await tweetStore.loadPinnedTweets(authorId);
    pinnedTweets.value?.sort((a: any, b: any) => (b.timestamp as number) - (a.timestamp as number));
    
    isLoading.value = false;
    initialLoad.value = false;
}

async function loadTweets(authorId: MimeiId) {
    if (isLoading.value) return;
    isLoading.value = true;
    pageNumber.value = 0; // Reset page number for initial load
    await tweetStore.loadTweetsByRank(authorId, pageNumber.value, pageSize);
    
    // Load pinned tweets
    pinnedTweets.value = await tweetStore.loadPinnedTweets(authorId);
    pinnedTweets.value?.sort((a: any, b: any) => (b.timestamp as number) - (a.timestamp as number));
    
    isLoading.value = false;
    initialLoad.value = false;
}

async function loadMoreTweets() {
    if (isLoading.value) return; // Prevent multiple loads
    isLoading.value = true;
    pageNumber.value++;
    const tweetsLoaded = await tweetStore.loadTweetsByRank(authorId.value, pageNumber.value, pageSize);
    
    // If fewer tweets than requested were loaded, there are no more tweets
    if (tweetsLoaded < pageSize) {
        console.log('No more tweets available from backend');
        // Optionally, you could disable scroll loading here
    }
    
    isLoading.value = false;
}

const tweetFeed = computed(() => {
    return tweetStore.tweets.filter(e => {
        if (e.isPrivate) {
            return tweetStore.loginUser?.mid === e.authorId && e.authorId === authorId.value;
        } else {
            return e.authorId === authorId.value;
        }
    });
});

watch(authorId, async (nv, ov) => {
    if (nv && nv !== ov) {
        pageNumber.value = 0; // Reset page number when loading new author's tweets
        await initialLoadTweets(nv);
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