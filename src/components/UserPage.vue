<script setup lang='ts'>
import { onMounted, ref, onUnmounted, watch, computed } from 'vue';
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

onMounted(() => {
    window.addEventListener('scroll', handleScroll);
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
            
            // If fewer tweets than requested were loaded, there are no more tweets
            if (loadedPageSize < pageSize) {
                console.log('No more tweets available from backend. Page number:', pageNumber.value);
                break;
            } else {
                // Load next page
                pageNumber.value++;
                console.log('Loaded', tweetsLoaded, 'tweets. Page number:', pageNumber.value);
            }

            if (tweetsLoaded >= minTweets) {
                break;
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
        appendNewToDisplayed();
        isLoading.value = false;
        initialLoad.value = false;
    }
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
            tweetStore.loadTweetsByUser(authorId.value, pageNumber.value, pageSize),
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
                console.log('No more tweets available from backend');
                hasMoreTweets.value = false;
            }
        }
    } catch (error) {
        if (error instanceof Error && error.message === 'TIMEOUT') {
            console.log('Scroll load timed out after 6s — will retry on next scroll');
        } else {
            console.error('Error loading more tweets:', error);
            if (!isManualRetry) hasMoreTweets.value = false;
        }
    } finally {
        appendNewToDisplayed();
        isLoading.value = false;
    }
}

const displayedTweets = ref<Tweet[]>([]);
const pendingCount = ref(0);

function appendNewToDisplayed() {
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const topTimestamp = displayedTweets.value.length > 0
        ? (displayedTweets.value[0].timestamp as number)
        : Infinity;

    const newTweets = tweetStore.tweets
        .filter(e => {
            if (existingIds.has(e.mid)) return false;
            const isAuthorMatch = e.isPrivate
                ? tweetStore.loginUser?.mid === e.authorId && e.authorId === authorId.value
                : e.authorId === authorId.value;
            return isAuthorMatch && (!e.originalTweetId || e.originalTweet !== null);
        })
        .sort((a, b) => (b.timestamp as number) - (a.timestamp as number));

    if (newTweets.length === 0) return;

    const newer = newTweets.filter(t => (t.timestamp as number) > topTimestamp);
    const older = newTweets.filter(t => (t.timestamp as number) <= topTimestamp);
    if (newer.length > 0) displayedTweets.value.unshift(...newer);
    if (older.length > 0) displayedTweets.value.push(...older);
}

function showPendingTweets() {
    appendNewToDisplayed();
    pendingCount.value = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Pick up any tweets added/removed in the store (e.g. background updates, deleteTweet)
watch(() => tweetStore.tweets.length, (newLen, oldLen) => {
    // Handle deletions — remove from displayed immediately
    if (newLen < oldLen) {
        const storeIds = new Set(tweetStore.tweets.map(t => t.mid));
        displayedTweets.value = displayedTweets.value.filter(t => storeIds.has(t.mid));
        return;
    }
    // Handle additions — only count as pending, don't auto-insert
    if (initialLoad.value || isLoading.value) return;
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const count = tweetStore.tweets.filter(e => {
        if (existingIds.has(e.mid)) return false;
        const isAuthorMatch = e.isPrivate
            ? tweetStore.loginUser?.mid === e.authorId && e.authorId === authorId.value
            : e.authorId === authorId.value;
        return isAuthorMatch && (!e.originalTweetId || e.originalTweet !== null);
    }).length;
    pendingCount.value = count;
});

// Single entry point for loading tweets — covers both initial mount and route changes
watch(authorId, async (nv, ov) => {
    if (!nv || nv === ov) return;

    console.log('UserPage loading authorId:', nv);
    tweetStore.removeUser(nv);  // force reload user data from its host.
    pageNumber.value = 0;
    hasMoreTweets.value = true;
    initialLoad.value = true;
    displayedTweets.value = [];
    await initialLoadTweets(nv);
    window.scrollTo(0, 0);
}, { immediate: true });

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
        <div v-if="pendingCount > 0" class="new-tweets-banner" @click="showPendingTweets">
            Show {{ pendingCount }} new tweet{{ pendingCount > 1 ? 's' : '' }}
        </div>
        <TweetView v-for='tweet in displayedTweets' :tweet='tweet' :key='tweet.mid'/>
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
.new-tweets-banner {
    text-align: center;
    padding: 10px;
    color: #1da1f2;
    cursor: pointer;
    border-bottom: 1px solid #e6ecf0;
    font-size: 14px;
}
.new-tweets-banner:hover {
    background-color: #f5f8fa;
}
</style>