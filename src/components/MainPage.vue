<script setup lang='ts'>
import { computed, onMounted, ref, onUnmounted } from 'vue';
import { useTweetStore } from '@/stores';
import { TweetView, AppHeader } from '@/views'

const tweetStore = useTweetStore();
const isLoading = ref(false);
const scrollThreshold = 200; // Distance from bottom to trigger load
const initialLoad = ref(true);
const pageNumber = ref(0);
const pageSize = 10; // Using the same TWEET_COUNT constant from tweetStore
const hasMoreTweets = ref(true); // Flag to track if more tweets are available

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

async function loadMoreTweets(isManualRetry = false) {
    if (isLoading.value) return; // Prevent multiple loads
    
    // For automatic loading, stop immediately if no more tweets
    if (!isManualRetry && !hasMoreTweets.value) {
        return;
    }
    
    isLoading.value = true;
    try {
        const tweetsLoaded = await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
        
        if (tweetsLoaded && tweetsLoaded > 0) {
            hasMoreTweets.value = true; // Re-enable loading if we got tweets
            pageNumber.value++;
        } else {
            // For automatic loading, stop immediately
            if (!isManualRetry) {
                console.log('No more tweets available from backend');
                hasMoreTweets.value = false;
            }
            // For manual retries, do nothing - let user keep trying
        }
    } catch (error) {
        console.error('Error loading more tweets:', error);
        
        // For automatic loading, stop on error
        if (!isManualRetry) {
            hasMoreTweets.value = false;
        }
        // For manual retries, do nothing - let user keep trying
    } finally {
        isLoading.value = false;
    }
}

const handleScroll = debounce(async () => {
    // Prevent multiple simultaneous loads
    if (isLoading.value) return;
    
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;

    if (documentHeight - scrollPosition < scrollThreshold) {
        // Store current scroll position before loading
        const currentScrollY = window.scrollY;
        const currentDocumentHeight = documentHeight;
        
        // Only load more tweets if we have more tweets available
        if (hasMoreTweets.value) {
            await loadMoreTweets(false); // Automatic loading
        }
        
        // Restore scroll position after loading to prevent jumping
        // Only if the document height increased (new content was added)
        const newDocumentHeight = document.documentElement.scrollHeight;
        if (newDocumentHeight > currentDocumentHeight) {
            // Use requestAnimationFrame for smooth scroll restoration
            requestAnimationFrame(() => {
                const heightDifference = newDocumentHeight - currentDocumentHeight;
                window.scrollTo({
                    top: currentScrollY + heightDifference,
                    behavior: 'instant' // Use instant to prevent animation conflicts
                });
            });
        }
    }
}, 300); // Increased debounce delay to reduce conflicts

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
    if (isLoading.value) return; // Prevent multiple loads
    
    isLoading.value = true;
    pageNumber.value = 0; // Reset page number for initial load
    hasMoreTweets.value = true; // Reset the flag for initial load

    // Load exactly 3 pages (30 tweets) initially
    const pagesToLoad = 3;
    let tweetsLoaded = 0;
    let round = 0;
    
    while (isLoading.value && round < pagesToLoad) {
        // Load initial page
        const loadedPageSize = await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
        if (loadedPageSize) {
            tweetsLoaded += loadedPageSize;
            round++;
        } else {
            console.warn("Init load failed. Cannot load tweets in round", round);
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
    const filteredTweets = tweetStore.tweets.filter(e => {
        // Filter out private tweets
        const isNotPrivate = !e.isPrivate;
        
        // Filter out tweets that have originalTweetId but originalTweet is null
        const hasValidOriginalTweet = !e.originalTweetId || e.originalTweet !== null;
        
        return isNotPrivate && hasValidOriginalTweet;
    });
    
    // Sort by timestamp in descending order (newest first)
    return filteredTweets.sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
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