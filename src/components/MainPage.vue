<script setup lang='ts'>
import { onMounted, ref, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useTweetStore } from '@/stores';
import { TweetView, AppHeader } from '@/views';
import { LoadingSpinner, PageLayout } from '@/components';
import { isWeChatBrowser } from '@/lib';
import { LOAD_TIMEOUT_MS, MAX_REFRESH_ATTEMPTS } from '@/constants';

const tweetStore = useTweetStore();
const router = useRouter();
const isLoading = ref(false);
const retryMessage = ref('');
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

function getNoMorePostsMessage(): string {
    const language = navigator.language || 'en';
    if (language.startsWith('zh')) return '没有更多帖子了';
    if (language.startsWith('ja')) return 'これ以上の投稿はありません';
    if (language.startsWith('ko')) return '더 이상 게시물이 없습니다';
    if (language.startsWith('es')) return 'No hay más publicaciones';
    if (language.startsWith('fr')) return 'Plus de publications';
    if (language.startsWith('de')) return 'Keine weiteren Beiträge';
    return 'No more posts';
}

async function loadMoreTweets(isManualRetry = false) {
    if (isLoading.value) return; // Prevent multiple loads

    // For automatic loading, stop immediately if no more tweets
    if (!isManualRetry && !hasMoreTweets.value) {
        return;
    }

    isLoading.value = true;

    try {
        const tweetsLoaded = await Promise.race([
            tweetStore.loadTweets(undefined, pageNumber.value, pageSize),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 6000))
        ]);

        if (tweetsLoaded && tweetsLoaded > 0) {
            if (tweetsLoaded < pageSize) {
                hasMoreTweets.value = false;
            } else {
                hasMoreTweets.value = true;
            }
            pageNumber.value++;
        } else {
            if (!isManualRetry) {
                console.log('No more tweets available from backend.');
                hasMoreTweets.value = false;
            }
        }
    } catch (error) {
        if (error instanceof Error && error.message === 'TIMEOUT') {
            console.log('Scroll load timed out after 6s — will retry on next scroll');
            // Do not stop pagination; user can trigger another scroll to retry
        } else {
            console.error('Error loading more tweets:', error);
            if (!isManualRetry) hasMoreTweets.value = false;
        }
    } finally {
        appendNewToDisplayed();
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
    // Guest user: redirect to the default user's profile page
    if (!tweetStore.loginUser) {
        router.replace(`/author/${tweetStore.followings[0]}`);
        return;
    }

    // Only load tweets if we don't have any yet or if this is a fresh session
    const shouldLoad = tweetStore.tweets.length === 0 || initialLoad.value;

    if (sessionStorage['isBot'] != 'No' && isWeChatBrowser()) {
        if (confirm(getBotVerificationMessage())) {
            sessionStorage['isBot'] = 'No'
            if (shouldLoad) {
                await loadTweetsWithMinimum()
            } else {
                appendNewToDisplayed();
            }
        } else {
            history.go(-1)
        }
    } else {
        // For non-WeChat browsers, automatically pass verification
        if (sessionStorage['isBot'] != 'No') {
            sessionStorage['isBot'] = 'No'
        }
        if (shouldLoad) {
            await loadTweetsWithMinimum()
        } else {
            appendNewToDisplayed();
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
            // Add timeout to each page load - timeout, refresh immediately on timeout (max attempts)
            const refreshCount = parseInt(sessionStorage.getItem('mainPageRefreshCount') || '0');

            let timeoutId: number | null = null;
            let hasTimedOut = false;
            const loadPromise = tweetStore.loadTweets(undefined, pageNumber.value, pageSize).then(result => {
                // Clear timeout immediately when load succeeds
                if (timeoutId && !hasTimedOut) {
                    clearTimeout(timeoutId);
                }
                return result;
            });
            const timeoutPromise = new Promise<never>((_, reject) =>
                timeoutId = window.setTimeout(() => {
                    hasTimedOut = true;
                    if (refreshCount < MAX_REFRESH_ATTEMPTS) {
                        console.warn(`Load timeout after ${LOAD_TIMEOUT_MS}ms, refreshing page (${refreshCount + 1}/${MAX_REFRESH_ATTEMPTS})`);
                        sessionStorage.setItem('mainPageRefreshCount', (refreshCount + 1).toString());
                        window.location.reload();
                    } else {
                        console.warn(`Max refresh attempts (${MAX_REFRESH_ATTEMPTS}) reached for MainPage, stopping`);
                        isLoading.value = false;
                        sessionStorage.removeItem('mainPageRefreshCount');
                    }
                    reject(new Error('Page load timeout'));
                }, LOAD_TIMEOUT_MS)
            );
            
            let loadedPageSize: number;
            try {
                loadedPageSize = await Promise.race([loadPromise, timeoutPromise]) as number;
                consecutiveFailures = 0;
                sessionStorage.removeItem('mainPageRefreshCount');
            } catch (error) {
                console.error('Unexpected error during load:', error);
                break;
            }

            if (loadedPageSize !== null && loadedPageSize !== undefined) {
                tweetsLoaded += loadedPageSize;
                round++;
                consecutiveFailures = 0;

                if (round === 1 && loadedPageSize === 0) {
                    console.log('First page loaded 0 tweets, no content available');
                    break;
                }
                
                // If fewer tweets than requested were loaded, there are no more tweets
                if (loadedPageSize < pageSize) {
                    console.log('No more tweets available from backend. Page number:', pageNumber.value);
                    break;
                } else {
                    // Load next page
                    pageNumber.value++;
                    console.log('Loaded', tweetsLoaded, 'tweets so far. Loading next page:', pageNumber.value);
                }
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
        appendNewToDisplayed();
        isLoading.value = false;
        initialLoad.value = false;
    }
}

const displayedTweets = ref<Tweet[]>([]);

function appendNewToDisplayed() {
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const topTimestamp = displayedTweets.value.length > 0
        ? (displayedTweets.value[0].timestamp as number)
        : Infinity;

    const newTweets = tweetStore.tweets
        .filter(e => {
            if (existingIds.has(e.mid)) return false;
            return !e.isPrivate && (!e.originalTweetId || e.originalTweet !== null);
        })
        .sort((a, b) => (b.timestamp as number) - (a.timestamp as number));

    if (newTweets.length === 0) return;

    const newer = newTweets.filter(t => (t.timestamp as number) > topTimestamp);
    const older = newTweets.filter(t => (t.timestamp as number) <= topTimestamp);
    if (newer.length > 0) displayedTweets.value.unshift(...newer);
    if (older.length > 0) displayedTweets.value.push(...older);
}

// Pick up tweets added in the background (e.g. updateFollowingTweets)
watch(() => tweetStore.tweets.length, () => appendNewToDisplayed());
</script>

<template>
    <PageLayout width="normal">
        <AppHeader />
        <TweetView v-for='tweet in displayedTweets' :tweet='tweet' :key='tweet.mid' />
        <div v-if='isLoading' class='d-flex flex-column align-items-center my-3'>
            <LoadingSpinner />
            <div v-if='retryMessage' class='text-muted mt-2 small'>
                {{ retryMessage }}
            </div>
        </div>
        <div v-else-if='!hasMoreTweets && displayedTweets.length > 0' class='text-center text-muted my-4 small'>
            {{ getNoMorePostsMessage() }}
        </div>
    </PageLayout>
</template>

<style scoped>
</style>