<script setup lang='ts'>
import { onMounted, ref, onUnmounted, watch, nextTick } from 'vue';
import { useRouter, onBeforeRouteLeave } from 'vue-router';
import { MAIN_FEED_SCROLL_KEY } from '@/constants/scrollRestore';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';
import { TweetView, AppHeader } from '@/views';
import { LoadingSpinner, PageLayout } from '@/components';
import { isWeChatBrowser } from '@/lib';


const { t } = useI18n();

const tweetStore = useTweetStore();
const router = useRouter();
const isLoading = ref(false);
const retryMessage = ref('');
const scrollThreshold = 200; // Distance from bottom to trigger load
const initialLoad = ref(true);
const pageNumber = ref(0);
const pageSize = 5; // Using the same TWEET_COUNT constant from tweetStore
const hasMoreTweets = ref(true); // Flag to track if more tweets are available
const loadError = ref(''); // Error message to display when loading fails
let lastErrorTime = 0;

function restoreMainFeedScroll() {
    const raw = sessionStorage.getItem(MAIN_FEED_SCROLL_KEY)
    if (raw === null) return
    const y = parseInt(raw, 10)
    if (Number.isNaN(y)) return
    const apply = () => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
        window.scrollTo(0, Math.min(Math.max(0, y), maxScroll))
    }
    nextTick(() => {
        requestAnimationFrame(() => {
            apply()
            requestAnimationFrame(apply)
        })
        setTimeout(apply, 50)
        setTimeout(apply, 200)
    })
}

function saveMainFeedScrollPosition() {
    sessionStorage.setItem(MAIN_FEED_SCROLL_KEY, String(window.scrollY))
}

onBeforeRouteLeave(() => {
    saveMainFeedScrollPosition()
})

function isNearBottom(threshold = scrollThreshold) {
    const scrollBottom = window.innerHeight + window.scrollY;
    const docHeight = document.documentElement.scrollHeight;
    return docHeight - scrollBottom <= threshold;
}

/** After a page loads, the scroll position does not change — no scroll event fires. Chain loads while the user is still near the bottom. */
function scheduleLoadMoreIfStillNearBottom() {
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
            void loadMoreTweets();
        },
        { root: null, rootMargin: '0px 0px 320px 0px', threshold: 0 },
    );
    loadMoreObserver.observe(el);
}

async function loadMoreTweets() {
    if (isLoading.value || !hasMoreTweets.value) return;

    isLoading.value = true;
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
        appendNewToDisplayed();
        isLoading.value = false;
        scheduleLoadMoreIfStillNearBottom();
    }
}

onMounted(async () => {
    // Guest user: redirect to the default user's profile page
    if (!tweetStore.loginUser) {
        router.replace(`/author/${tweetStore.followings[0]}`);
        return;
    }

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
    nextTick(() => setupLoadMoreObserver());
    restoreMainFeedScroll();
});

onUnmounted(() => {
    loadMoreObserver?.disconnect();
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
const pendingCount = ref(0);

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
    pendingCount.value = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Pick up tweets added/removed in the background (e.g. updateFollowingTweets, deleteTweet)
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
    const count = tweetStore.tweets.filter(e =>
        !existingIds.has(e.mid) && !e.isPrivate && (!e.originalTweetId || e.originalTweet !== null)
    ).length;
    pendingCount.value = count;
});

watch(displayedTweets, () => nextTick(() => setupLoadMoreObserver()), { flush: 'post' });
</script>

<template>
    <PageLayout>
        <AppHeader />
        <div v-if="pendingCount > 0" class="new-tweets-banner" @click="showPendingTweets">
            {{ $t('tweet.showNewTweets', pendingCount) }}
        </div>
        <TweetView v-for='tweet in displayedTweets' :tweet='tweet' :key='tweet.mid' />
        <div ref="loadMoreSentinel" class="load-more-sentinel" aria-hidden="true" />
        <div v-if='isLoading && !initialLoad' class='tweet-feed-loading-fixed'>
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

.load-more-sentinel {
    width: 100%;
    height: 1px;
    pointer-events: none;
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