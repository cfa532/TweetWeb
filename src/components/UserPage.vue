<script setup lang='ts'>
import { onMounted, ref, onUnmounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';
import { useRoute } from 'vue-router';
import { LOAD_TIMEOUT_MS, MAX_REFRESH_ATTEMPTS } from '@/constants';
import { TweetView, AppHeader } from '@/views';
import { isWeChatBrowser } from '@/lib';
import { LoadingSpinner, PageLayout } from '@/components';

const { t } = useI18n();

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
const loadPaused = ref(false); // Paused due to timeout — prevents endless retry

onMounted(() => {
    window.addEventListener('scroll', handleScroll);
});

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll);
});

async function initialLoadTweets(authorId: MimeiId) {
    if (sessionStorage['isBot'] !== 'No' && isWeChatBrowser()) {
        if (confirm(t('botVerification'))) {
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

async function loadPinnedTweetsForUser(authorId: MimeiId) {
    try {
        const refreshCount = parseInt(sessionStorage.getItem('userPageRefreshCount') || '0');
        let pinnedHasTimedOut = false;
        let timeoutId: number | null = null;

        const pinnedPromise = tweetStore.loadPinnedTweets(authorId).then(result => {
            if (timeoutId && !pinnedHasTimedOut) {
                clearTimeout(timeoutId);
            }
            return result;
        });

        const pinnedTimeout = new Promise<Tweet[]>((_, reject) => {
            timeoutId = window.setTimeout(() => {
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

        const freshPinned = await Promise.race([pinnedPromise, pinnedTimeout]);
        if (freshPinned?.length) {
            freshPinned.sort((a: any, b: any) => (b.timestamp as number) - (a.timestamp as number));

            // Merge fresh data into existing cached entries so Vue keeps the same
            // component instances (and running videos) instead of re-creating them.
            const existingMap = new Map(pinnedTweets.value.map(t => [t.mid, t]));
            const freshIds = new Set(freshPinned.map((t: Tweet) => t.mid));

            // Remove pinned tweets that are no longer pinned
            pinnedTweets.value = pinnedTweets.value.filter(t => freshIds.has(t.mid));

            // Update existing tweets in-place with scalar changes; append truly new ones
            for (const ft of freshPinned) {
                const existing = existingMap.get(ft.mid);
                if (existing) {
                    // Update scalar fields only — preserve media/author refs to avoid video restart
                    for (const key of ['content', 'likeCount', 'commentCount', 'retweetCount', 'bookmarkCount', 'timestamp', 'isPrivate', 'downloadable'] as (keyof Tweet)[]) {
                        if (existing[key] !== ft[key]) {
                            (existing as any)[key] = ft[key];
                        }
                    }
                } else {
                    pinnedTweets.value.push(ft);
                }
            }

            tweetStore.cachePinnedTweets(authorId, pinnedTweets.value);
        }
        sessionStorage.removeItem('userPageRefreshCount');
    } catch (error) {
        console.error('Unexpected error loading pinned tweets:', error);
        pinnedTweets.value = [];
    }
}

async function loadTweetsWithMinimum(authorId: MimeiId) {
    if (isLoading.value) return; // Prevent multiple loads
    
    isLoading.value = true;

    let currentTimeoutId: number | null = null;

    // Start loading pinned tweets in parallel with regular tweets so the pinned
    // video (shown first on the page) gets priority bandwidth.
    const pinnedPromiseOuter = loadPinnedTweetsForUser(authorId);

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
                hasMoreTweets.value = false;
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
        
        // Await the pinned tweets that were kicked off in parallel
        await pinnedPromiseOuter;
    } catch (error) {
        console.error('Error in loadTweetsWithMinimum:', error);
    } finally {
        if (currentTimeoutId) {
            clearTimeout(currentTimeoutId);
        }
        // Reconcile: remove cached tweets no longer on server, add new ones
        const storeIds = new Set(tweetStore.tweets.map(t => t.mid));
        const filtered = displayedTweets.value.filter(t => storeIds.has(t.mid));
        // Only replace array if items were actually removed, to avoid unnecessary re-render
        if (filtered.length !== displayedTweets.value.length) {
            displayedTweets.value = filtered;
        }
        appendNewToDisplayed();
        isLoading.value = false;
        initialLoad.value = false;
    }
}

async function loadMoreTweets(isManualRetry = false) {
    if (isLoading.value) return; // Prevent multiple loads

    // For automatic loading, stop if no more tweets or paused due to failures
    if (!isManualRetry && (!hasMoreTweets.value || loadPaused.value)) {
        return;
    }

    isLoading.value = true;

    try {
        const tweetsLoaded = await Promise.race([
            tweetStore.loadTweetsByUser(authorId.value, pageNumber.value, pageSize),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 6000))
        ]);

        if (tweetsLoaded && tweetsLoaded > 0) {
            loadPaused.value = false;
            if (tweetsLoaded <= pageSize) {
                hasMoreTweets.value = false;
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
            console.log('Scroll load timed out after 6s — pausing auto-load');
            loadPaused.value = true;
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
    const displayedMap = new Map(displayedTweets.value.map(t => [t.mid, t]));

    // Update only scalar fields that may change (e.g. likeCount, content)
    // Avoid replacing object/array references (media, author) to prevent video re-renders
    const scalarKeys: (keyof Tweet)[] = [
        'content', 'likeCount', 'commentCount', 'retweetCount',
        'bookmarkCount', 'timestamp', 'isPrivate', 'downloadable',
    ];
    for (const storeTweet of tweetStore.tweets) {
        const existing = displayedMap.get(storeTweet.mid);
        if (existing) {
            for (const key of scalarKeys) {
                if (existing[key] !== storeTweet[key]) {
                    (existing as any)[key] = storeTweet[key];
                }
            }
        }
    }

    const existingIds = new Set(displayedMap.keys());
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
    pageNumber.value = 0;
    hasMoreTweets.value = true;
    loadPaused.value = false;
    initialLoad.value = true;

    // Show cached tweets instantly while fresh data loads
    const cached = tweetStore.getCachedUserTweets(nv);
    displayedTweets.value = cached;
    pinnedTweets.value = tweetStore.getCachedPinnedTweets(nv);
    if (cached.length > 0) {
        console.log(`Showing ${cached.length} cached tweets for ${nv}`);
    }

    tweetStore.removeUser(nv);  // force reload user data from its host.
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
    <PageLayout>
        <AppHeader :userId='authorId' />
        <b v-if='pinnedTweets?.length!>0'>&nbsp;&nbsp;{{ $t('profile.pinned') }}</b>
        <TweetView v-for='tweet in pinnedTweets' :tweet='tweet' :key='tweet.mid'/>
        <hr v-if='pinnedTweets?.length!>0' />
        <b v-if='pinnedTweets?.length!>0'>&nbsp;&nbsp;{{ $t('profile.tweets') }}</b>
        <div v-if="pendingCount > 0" class="new-tweets-banner" @click="showPendingTweets">
            {{ $t('tweet.showNewTweets', pendingCount) }}
        </div>
        <TweetView v-for='tweet in displayedTweets' :tweet='tweet' :key='tweet.mid'/>
        <div v-if='isLoading' class='d-flex flex-column align-items-center my-3'>
            <LoadingSpinner />
            <div v-if='retryMessage' class='text-muted mt-2 small'>
                {{ retryMessage }}
            </div>
        </div>
        <div v-if='!isLoading && !hasMoreTweets && displayedTweets.length > 0' class='text-center my-4 small' style='color: #8899a6;'>
            {{ $t('tweet.noMorePosts') }}
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