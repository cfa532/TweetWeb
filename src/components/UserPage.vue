<script setup lang='ts'>
import { computed, onMounted, ref, onUnmounted, watch } from 'vue';
import { useTweetStore } from '@/stores';
import { useRoute } from 'vue-router';
import { LOAD_TIMEOUT_MS, MAX_REFRESH_ATTEMPTS } from '@/constants';
import { TweetView, AppHeader } from '@/views';
import { isWeChatBrowser } from '@/lib';
import { LoadingSpinner, PageLayout } from '@/components';

const tweetStore = useTweetStore();
const isLoading = ref(false);
const retryMessage = ref('');
const pageNumber = ref(0);
const scrollThreshold = 200; // Distance from bottom to trigger load
const route = useRoute();
const authorId = computed(() => route.params.authorId as MimeiId);
const pinnedTweets = ref<Tweet[]>([]);
const pageSize = 10; // Using the same page size as MainPage
const initialLoad = ref(true);
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

onMounted(async () => {
    // Wait a tick for route params to be fully available
    if (!authorId.value) {
        console.error('UserPage: authorId is undefined, waiting for route to be ready...');
        // Wait for next tick and check again
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!authorId.value) {
            console.error('UserPage: authorId still undefined after wait');
            return;
        }
    }
    
    console.log('UserPage mounted for authorId:', authorId.value);
    tweetStore.removeUser(authorId.value);  // force reload user data from its host.
    await initialLoadTweets(authorId.value);
    window.addEventListener('scroll', handleScroll);
    // Scroll to top when page is opened
    window.scrollTo(0, 0);
});

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll);
});

async function initialLoadTweets(authorId: MimeiId) {
    if (sessionStorage['isBot'] !== 'No' && isWeChatBrowser()) {
        if (confirm(getBotVerificationMessage())) {
            sessionStorage['isBot'] = 'No';
            await loadTweetsWithMinimum(authorId);
        } else {
            history.go(-1);
        }
    } else {
        // For non-WeChat browsers, automatically pass verification
        if (sessionStorage['isBot'] !== 'No') {
            sessionStorage['isBot'] = 'No';
        }
        await loadTweetsWithMinimum(authorId);
    }
}

async function loadTweetsWithMinimum(authorId: MimeiId) {
    if (isLoading.value) return; // Prevent multiple loads
    
    isLoading.value = true;
    pageNumber.value = 0; // Reset page number for initial load
    hasMoreTweets.value = true; // Reset the flag for initial load

    let currentTimeoutId: number | null = null;

    try {
        // Keep loading more pages until we have at least 6 tweets or no more tweets
        const minTweets = 6;
        let tweetsLoaded = 0;
        let round = 0;
        let consecutiveFailures = 0;
        const maxConsecutiveFailures = 2; // Allow up to 2 consecutive failures before giving up
        while (isLoading.value && round < 10) {
            // Add timeout to each page load - timeout, refresh immediately on timeout (max attempts)
            const refreshCount = parseInt(sessionStorage.getItem('userPageRefreshCount') || '0');

            let hasTimedOut = false;
            const loadPromise = tweetStore.loadTweetsByUser(authorId, pageNumber.value, pageSize).then(result => {
                // Clear timeout immediately when load succeeds
                if (currentTimeoutId && !hasTimedOut) {
                    clearTimeout(currentTimeoutId);
                }
                return result;
            });

            // Set timeout to refresh on failure
            const timeoutPromise = new Promise<never>((_, reject) => {
                currentTimeoutId = window.setTimeout(() => {
                    hasTimedOut = true;
                    if (refreshCount < MAX_REFRESH_ATTEMPTS) {
                        console.warn(`Load timeout after ${LOAD_TIMEOUT_MS}ms, refreshing page (${refreshCount + 1}/${MAX_REFRESH_ATTEMPTS})`);
                        sessionStorage.setItem('userPageRefreshCount', (refreshCount + 1).toString());
                        window.location.reload();
                    } else {
                        console.warn(`Max refresh attempts (${MAX_REFRESH_ATTEMPTS}) reached for UserPage, stopping`);
                        isLoading.value = false;
                        sessionStorage.removeItem('userPageRefreshCount');
                    }
                    reject(new Error('Page load timeout'));
                }, LOAD_TIMEOUT_MS);
            });

            let loadedPageSize: number;
            try {
                loadedPageSize = await Promise.race([loadPromise, timeoutPromise]) as number;
                consecutiveFailures = 0; // Reset on success
                sessionStorage.removeItem('userPageRefreshCount'); // Clear refresh count on success
            } catch (error) {
                // Timeout already handled the refresh, this catch is for any other errors
                // which should be extremely rare since timeout handles the refresh
                console.error('Unexpected error during load:', error);
                break;
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
        
        // Log final result
        if (tweetsLoaded > 0) {
            console.log(`Initial load completed: ${tweetsLoaded} tweets loaded in ${round} round(s)`);
        } else {
            console.warn('Initial load completed with no tweets loaded');
        }
        
        // Load pinned tweets (with 6-second timeout, refresh on failure - max 5 refreshes)
        try {
            const refreshCount = parseInt(sessionStorage.getItem('userPageRefreshCount') || '0');
            let pinnedHasTimedOut = false;
            const pinnedPromise = tweetStore.loadPinnedTweets(authorId).then(result => {
                // Clear timeout immediately when load succeeds
                if (currentTimeoutId && !pinnedHasTimedOut) {
                    clearTimeout(currentTimeoutId);
                }
                return result;
            });

            const pinnedTimeout = new Promise<Tweet[]>((_, reject) => {
                currentTimeoutId = window.setTimeout(() => {
                    pinnedHasTimedOut = true;
                    if (refreshCount < MAX_REFRESH_ATTEMPTS) {
                        console.warn(`Pinned tweets timeout after ${LOAD_TIMEOUT_MS}ms, refreshing page (${refreshCount + 1}/${MAX_REFRESH_ATTEMPTS})`);
                        sessionStorage.setItem('userPageRefreshCount', (refreshCount + 1).toString());
                        window.location.reload();
                    } else {
                        console.warn(`Max refresh attempts (${MAX_REFRESH_ATTEMPTS}) reached for UserPage pinned tweets, stopping`);
                        isLoading.value = false;
                        sessionStorage.removeItem('userPageRefreshCount');
                    }
                    reject(new Error('Pinned tweets timeout'));
                }, LOAD_TIMEOUT_MS);
            });

            pinnedTweets.value = await Promise.race([pinnedPromise, pinnedTimeout]);
            pinnedTweets.value?.sort((a: any, b: any) => (b.timestamp as number) - (a.timestamp as number));
            sessionStorage.removeItem('userPageRefreshCount'); // Clear on success
        } catch (error) {
            // Timeout already handled the refresh
            console.error('Unexpected error loading pinned tweets:', error);
            pinnedTweets.value = [];
        }
    } catch (error) {
        console.error('Error in loadTweetsWithMinimum:', error);
    } finally {
        if (currentTimeoutId) {
            clearTimeout(currentTimeoutId);
        }
        isLoading.value = false;
        initialLoad.value = false;
    }
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
        const tweetsLoaded = await tweetStore.loadTweetsByUser(authorId.value, pageNumber.value, pageSize);
        
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
        hasMoreTweets.value = true; // Reset the flag for new user
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
</script>

<template>
    <PageLayout width="normal">
        <AppHeader :userId='authorId' />
        <b v-if='pinnedTweets?.length!>0'>&nbsp;&nbsp;Pinned</b>
        <TweetView v-for='tweet in pinnedTweets' :tweet='tweet' :key='tweet.mid'/>
        <hr v-if='pinnedTweets?.length!>0' />
        <b v-if='pinnedTweets?.length!>0'>&nbsp;&nbsp;Tweets</b>
        <TweetView v-for='tweet in tweetFeed' :tweet='tweet' :key='tweet.mid'/>
        <div v-if='isLoading' class='d-flex flex-column align-items-center my-3'>
            <LoadingSpinner />
            <div v-if='retryMessage' class='text-muted mt-2 small'>
                {{ retryMessage }}
            </div>
        </div>
    </PageLayout>
</template>

<style scoped>

</style>