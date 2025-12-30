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

// Localization for bot verification
function getBotVerificationMessage(): string {
    const language = navigator.language || 'en';
    
    if (language.startsWith('zh')) {
        return '点击OK。证明你不是机器人\n\n芝麻，开门！';
    } else if (language.startsWith('ja')) {
        return 'OKをクリック。あなたがロボットではないことを証明してください\n\n開け！ゴマ';
    } else {
        return 'Click OK. Prove you aren\'t bot.\n\nOpen Sesame!';
    }
}

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
        // Load tweets without aggressive timeout - let connection pool handle timeouts
        const tweetsLoaded = await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
        
        if (tweetsLoaded && tweetsLoaded > 0) {
            // Check if we've reached the end of the list
            if (tweetsLoaded < pageSize) {
                // Fewer tweets than requested = no more tweets available
                console.log(`Reached end of tweet list. Loaded ${tweetsLoaded} tweets (less than page size ${pageSize})`);
                hasMoreTweets.value = false;
            } else {
                // Full page loaded, there might be more
                hasMoreTweets.value = true;
            }
            pageNumber.value++;
        } else {
            // No tweets loaded
            if (!isManualRetry) {
                console.log('No more tweets available from backend.');
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
        // Only load more tweets if we have more tweets available
        if (hasMoreTweets.value) {
            await loadMoreTweets(false); // Automatic loading
        }
    }
}, 300); // Increased debounce delay to reduce conflicts

onMounted(async () => {
    // Only load tweets if we don't have any yet or if this is a fresh session
    const shouldLoad = tweetStore.tweets.length === 0 || initialLoad.value;
    
    if (sessionStorage['isBot'] != 'No') {
        if (confirm(getBotVerificationMessage())) {
            sessionStorage['isBot'] = 'No'
            if (shouldLoad) {
                await loadTweetsWithMinimum()
            }
        } else {
            history.go(-1)
        }
    } else {
        if (shouldLoad) {
            await loadTweetsWithMinimum()
        }
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

    // Set timeout to hide spinner after 15 seconds (increased to accommodate getProviderIp health checks)
    const timeoutId = setTimeout(() => {
        if (isLoading.value) {
            console.warn('Initial load timeout after 15 seconds, hiding spinner');
            isLoading.value = false;
            initialLoad.value = false;
        }
    }, 15000);

    try {
        // Load exactly 3 pages (30 tweets) initially
        const pagesToLoad = 3;
        let tweetsLoaded = 0;
        let round = 0;
        let consecutiveFailures = 0;
        const maxConsecutiveFailures = 2; // Allow up to 2 consecutive failures before giving up
        
        while (isLoading.value && round < pagesToLoad) {
            // Add timeout to each page load - increased to 20 seconds to accommodate getProviderIp health checks
            const loadPromise = tweetStore.loadTweets(undefined, pageNumber.value, pageSize);
            const timeoutPromise = new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('Page load timeout')), 20000)
            );
            
            let loadedPageSize: number;
            try {
                loadedPageSize = await Promise.race([loadPromise, timeoutPromise]) as number;
                consecutiveFailures = 0; // Reset on success
            } catch (error) {
                console.warn("Init load failed in round", round, error);
                consecutiveFailures++;
                
                // Continue to next page if we haven't exceeded max failures
                if (consecutiveFailures >= maxConsecutiveFailures) {
                    console.warn("Too many consecutive failures, stopping initial load");
                    break;
                }
                
                // Still increment page number and round to try next page
                pageNumber.value++;
                round++;
                continue;
            }
            
            if (loadedPageSize) {
                tweetsLoaded += loadedPageSize;
                round++;
            } else {
                console.warn("Init load failed. Cannot load tweets in round", round);
                consecutiveFailures++;
                
                // Continue to next page if we haven't exceeded max failures
                if (consecutiveFailures >= maxConsecutiveFailures) {
                    console.warn("Too many consecutive failures, stopping initial load");
                    break;
                }
                
                // Still increment page number and round to try next page
                pageNumber.value++;
                round++;
                continue;
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
        
        // Log final result
        if (tweetsLoaded > 0) {
            console.log(`Initial load completed: ${tweetsLoaded} tweets loaded in ${round} round(s)`);
        } else {
            console.warn('Initial load completed with no tweets loaded');
        }
    } catch (error) {
        console.error('Error in loadTweetsWithMinimum:', error);
    } finally {
        clearTimeout(timeoutId);
        isLoading.value = false;
        initialLoad.value = false;
    }
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