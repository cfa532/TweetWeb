<script setup lang='ts'>
import { onMounted, onActivated, ref, onUnmounted, watch, nextTick, computed } from 'vue';
defineOptions({ name: 'MainPage' })
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';
import { AppHeader } from '@/views';
import { LoadingSpinner, PageLayout, TweetList } from '@/components';
import { isWeChatBrowser } from '@/lib';
import { useScrollRestore } from '@/composables/useScrollRestore';


const { t } = useI18n();

const tweetStore = useTweetStore();
const router = useRouter();
const isLoading = ref(false);
const showLoadMoreSpinner = ref(false);
const retryMessage = ref('');
const scrollThreshold = 200; // Distance from bottom to trigger load
const initialLoad = ref(true);
const pageNumber = ref(0);
const pageSize = 5; // Using the same TWEET_COUNT constant from tweetStore
const hasMoreTweets = ref(true); // Flag to track if more tweets are available
const loadError = ref(''); // Error message to display when loading fails
let lastErrorTime = 0;
let loadMoreSpinnerTimer: ReturnType<typeof setTimeout> | null = null;

function startLoadMoreSpinnerDelay() {
    clearLoadMoreSpinnerDelay();
    // Only show spinner if loading takes longer than 1s.
    loadMoreSpinnerTimer = setTimeout(() => {
        if (isLoading.value && !initialLoad.value) {
            showLoadMoreSpinner.value = true;
        }
    }, 1000);
}

function clearLoadMoreSpinnerDelay() {
    if (loadMoreSpinnerTimer) {
        clearTimeout(loadMoreSpinnerTimer);
        loadMoreSpinnerTimer = null;
    }
    showLoadMoreSpinner.value = false;
}

function isNearBottom(threshold = scrollThreshold) {
    const scrollBottom = window.innerHeight + window.scrollY;
    const docHeight = document.documentElement.scrollHeight;
    return docHeight - scrollBottom <= threshold;
}

/** After a page loads, the scroll position does not change — no scroll event fires. Chain loads while the user is still near the bottom. */
function scheduleLoadMoreIfStillNearBottom() {
    if (isRestoringFeed.value) return;
    void (async () => {
        await nextTick();
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (isLoading.value || !hasMoreTweets.value) return;
        if (lastErrorTime && Date.now() - lastErrorTime < 2000) return;
        if (!isNearBottom()) return;
        await loadMoreTweets();
    })();
}

const loadMoreSentinel = ref<HTMLElement | null>(null);
let loadMoreObserver: IntersectionObserver | null = null;

function setupLoadMoreObserver() {
    loadMoreObserver?.disconnect();
    const el = loadMoreSentinel.value;
    if (!el) return;
    loadMoreObserver = new IntersectionObserver(
        (entries) => {
            if (!entries[0]?.isIntersecting) return;
            if (isLoading.value || !hasMoreTweets.value) return;
            if (lastErrorTime && Date.now() - lastErrorTime < 2000) return;
            if (isRestoringFeed.value) return;
            void loadMoreTweets();
        },
        { root: null, rootMargin: '0px 0px 320px 0px', threshold: 0 },
    );
    loadMoreObserver.observe(el);
}

async function loadMoreTweets() {
    if (isLoading.value || !hasMoreTweets.value) return;

    isLoading.value = true;
    if (!initialLoad.value) {
        startLoadMoreSpinnerDelay();
    }
    loadError.value = '';

    try {
        const tweetsLoaded = await tweetStore.loadTweets(undefined, pageNumber.value, pageSize);

        if (tweetsLoaded && tweetsLoaded > 0) {
            if (tweetsLoaded < pageSize) {
                hasMoreTweets.value = false;
            } else {
                hasMoreTweets.value = true;
            }
            pageNumber.value++;
        } else {
            console.log('No more tweets available from backend.');
            hasMoreTweets.value = false;
        }
    } catch (error) {
        console.error('Error loading more tweets:', error);
        loadError.value = t('tweet.loadMoreError');
        lastErrorTime = Date.now();
    } finally {
        clearLoadMoreSpinnerDelay();
        appendNewToDisplayed();
        isLoading.value = false;
        scheduleLoadMoreIfStillNearBottom();
    }
}

// Persist & restore the feed's scroll position without the top-then-position
// flash on back-navigation (synchronous, keep-alive DOM) and reload (page in
// content first). See composables/useScrollRestore.ts.
const { restoring: isRestoringFeed, restoreAfterLoad } = useScrollRestore('main', {
    hasMore: () => hasMoreTweets.value,
    loadMore: loadMoreTweets,
});

// The mid the currently-displayed feed was loaded for. Used by onActivated to
// detect a login-user change while this component is kept alive (<keep-alive>).
const loadedForUser = ref<string | null>(null)

onMounted(async () => {
    // Guest user: redirect to the default user's profile page
    if (!tweetStore.loginUser) {
        router.replace(`/author/${tweetStore.followings[0]}`);
        return;
    }
    loadedForUser.value = tweetStore.loginUser.mid

    // Only load tweets if we don't have any yet or if this is a fresh session
    const shouldLoad = tweetStore.tweets.length === 0 || initialLoad.value;

    if (sessionStorage['isBot'] != 'No' && isWeChatBrowser()) {
        if (confirm(t('botVerification'))) {
            sessionStorage['isBot'] = 'No'
            if (shouldLoad) {
                await loadTweetsWithMinimum()
            } else {
                appendNewToDisplayed();
            }
        } else {
            history.go(-1)
            return
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
    await restoreAfterLoad();
    nextTick(() => setupLoadMoreObserver());
});

// Kept alive across navigation, so onMounted won't re-run on return. Guard the
// auth-coupled cases: a logged-out user must be redirected, and a changed login
// user must get a fresh feed. The common case (same user returning) does nothing,
// preserving scroll position.
onActivated(() => {
    if (!tweetStore.loginUser) {
        router.replace(`/author/${tweetStore.followings[0]}`);
        return;
    }
    if (loadedForUser.value !== tweetStore.loginUser.mid) {
        loadedForUser.value = tweetStore.loginUser.mid;
        displayedTweets.value = [];
        initialLoad.value = true;
        loadTweetsWithMinimum();
    }
});

onUnmounted(() => {
    loadMoreObserver?.disconnect();
    clearLoadMoreSpinnerDelay();
});

async function loadTweetsWithMinimum() {
    if (isLoading.value) return;

    pageNumber.value = 0;
    hasMoreTweets.value = true;
    loadError.value = '';

    try {
        await loadMoreTweets();
    } catch (error) {
        console.error('Error in loadTweetsWithMinimum:', error);
    } finally {
        initialLoad.value = false;
    }
}

const displayedTweets = ref<Tweet[]>([]);
// Number of store tweets not yet shown. A computed (not a ref bumped in a
// watcher) so it can't go stale when a pagination appendNewToDisplayed() pulls
// those same tweets into the feed before the user taps — which previously left
// the banner visible with nothing new to show.
const pendingCount = computed(() => {
    if (initialLoad.value) return 0;
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    return tweetStore.tweets.filter(e =>
        !existingIds.has(e.mid) && !e.isPrivate && (!e.originalTweetId || e.originalTweet !== null)
    ).length;
});

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

function showPendingTweets() {
    appendNewToDisplayed();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Remove deleted tweets from the feed immediately. (Additions are reflected by
// the pendingCount computed, so they don't need handling here.)
watch(() => tweetStore.tweets.length, (newLen, oldLen) => {
    if (newLen < oldLen) {
        const storeIds = new Set(tweetStore.tweets.map(t => t.mid));
        displayedTweets.value = displayedTweets.value.filter(t => storeIds.has(t.mid));
    }
});

watch(displayedTweets, () => nextTick(() => setupLoadMoreObserver()), { flush: 'post' });
</script>

<template>
    <PageLayout>
        <AppHeader />
        <div v-if="isRestoringFeed" class="feed-restoring-overlay" aria-live="polite">
            <LoadingSpinner />
        </div>
        <div v-if="pendingCount > 0" class="new-tweets-banner" @click="showPendingTweets">
            {{ $t('tweet.showNewTweets', pendingCount) }}
        </div>
        <div :class="{ 'feed-restoring': isRestoringFeed }">
            <TweetList :tweets="displayedTweets" />
        </div>
        <div ref="loadMoreSentinel" class="load-more-sentinel" aria-hidden="true" />
        <div v-if='showLoadMoreSpinner && isLoading && !initialLoad' class='tweet-feed-loading-fixed'>
            <LoadingSpinner size="sm" />
            <span v-if="!retryMessage" class="small" style="color: #8899a6;">{{ $t('common.loading') }}</span>
            <div v-else class="small text-muted">{{ retryMessage }}</div>
        </div>
        <div v-else-if='isLoading' class='d-flex flex-column align-items-center justify-content-center gap-2 my-4 py-3 tweet-list-load-more'>
            <LoadingSpinner />
            <span v-if="!retryMessage" class="small" style="color: #8899a6;">{{ $t('common.loading') }}</span>
            <div v-if='retryMessage' class='text-muted small'>
                {{ retryMessage }}
            </div>
        </div>
        <div v-if='!isLoading && loadError && hasMoreTweets' class='text-center my-3 small' style='color: #8899a6;'>
            {{ loadError }}
        </div>
        <div v-if='!isLoading && !hasMoreTweets && displayedTweets.length > 0' class='text-center text-muted my-4 small'>
            {{ $t('tweet.noMorePosts') }}
        </div>
    </PageLayout>
</template>

<style scoped>
.new-tweets-banner {
    position: fixed;
    top: calc(12px + env(safe-area-inset-top));
    left: 50%;
    z-index: 2147482999;
    width: min(520px, calc(100vw - 24px));
    transform: translateX(-50%);
    text-align: center;
    padding: 10px;
    color: #1da1f2;
    cursor: pointer;
    border: 1px solid #e6ecf0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
    font-size: 14px;
}
.new-tweets-banner:hover {
    background-color: #f5f8fa;
}

.load-more-sentinel {
    width: 100%;
    height: 1px;
    pointer-events: none;
}

/* While paging in content to reach a saved scroll offset (deep reload), keep the
   feed's layout for measurement but hide it so the top of the list never flashes. */
.feed-restoring {
    visibility: hidden;
}

.feed-restoring-overlay {
    position: fixed;
    inset: 0;
    z-index: 1030;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.8);
}

.tweet-feed-loading-fixed {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1040;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.65rem 1rem;
    background: rgba(255, 255, 255, 0.92);
    border-top: 1px solid #e6ecf0;
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.06);
}
</style>
