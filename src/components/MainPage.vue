<script setup lang='ts'>
import { onMounted, onActivated, ref, onUnmounted, watch, nextTick, computed, type Ref } from 'vue';
defineOptions({ name: 'MainPage' })
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';
import { AppHeader } from '@/views';
import { LoadingSpinner, PageLayout, TweetList } from '@/components';
import { isWeChatBrowser } from '@/lib';
import { useScrollRestore } from '@/composables/useScrollRestore';
import { useFeedPendingCount } from '@/composables/useFeedPendingCount';
import { startFeedPolling } from '@/composables/useFeedPolling';


const { t } = useI18n();

const tweetStore = useTweetStore();
const router = useRouter();
const route = useRoute();
const { syncFeedDisplayed } = useFeedPendingCount();
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
const bannerVisible = ref(false);
let bannerHideTimer: ReturnType<typeof setTimeout> | null = null;

function showBanner() {
    bannerVisible.value = true;
    if (bannerHideTimer) clearTimeout(bannerHideTimer);
    bannerHideTimer = setTimeout(() => { bannerVisible.value = false; }, 60000);
}
function hideBanner() {
    bannerVisible.value = false;
    if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
}

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

    // App-wide poll for new following tweets (3 min). Singleton — also started by
    // UserPage, so the banner stays current on either the main feed or a profile.
    startFeedPolling();
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
        return;
    }
    // Navigated back from another page with the "show new" intent (e.g. UserPage banner tap).
    if (route.query.showNew) {
        router.replace({ path: '/' });
        showPendingTweets();
    }
});

onUnmounted(() => {
    loadMoreObserver?.disconnect();
    clearLoadMoreSpinnerDelay();
    hideBanner();
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

// Keep the shared composable in sync so other pages (e.g. UserPage) can read
// the live feed pending count without duplicating the logic.
// Track array length so the watcher fires on push/unshift (array mutations don't
// change the ref's identity, so deep:false would miss them).
watch(
    [() => displayedTweets.value.length, () => initialLoad.value] as const,
    () => syncFeedDisplayed(displayedTweets.value, !initialLoad.value),
    { immediate: true },
);

// Number of store tweets not yet shown. A computed (not a ref bumped in a
// watcher) so it can't go stale when a pagination appendNewToDisplayed() pulls
// those same tweets into the feed before the user taps — which previously left
// the banner visible with nothing new to show.
const pendingCount = computed(() => {
    if (initialLoad.value) return 0;
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const topTimestamp = displayedTweets.value.length > 0
        ? (displayedTweets.value[0].timestamp as number)
        : 0;
    return tweetStore.tweets.filter(e =>
        tweetStore.feedTweetIds.has(e.mid) &&
        !existingIds.has(e.mid) &&
        !e.isPrivate &&
        (!e.originalTweetId || e.originalTweet !== null) &&
        (e.timestamp as number) > topTimestamp
    ).length;
});

watch(pendingCount, (count, prev) => {
    if (count > 0 && (prev === 0 || !bannerVisible.value)) showBanner();
    else if (count === 0) hideBanner();
});

const pendingAuthors = computed(() => {
    if (!pendingCount.value) return [];
    const existingIds = new Set(displayedTweets.value.map((t: any) => t.mid));
    const topTimestamp = displayedTweets.value.length > 0
        ? (displayedTweets.value[0].timestamp as number)
        : 0;
    const seen = new Set<string>();
    const authors: any[] = [];
    for (const t of tweetStore.tweets as any[]) {
        if (!tweetStore.feedTweetIds.has(t.mid)) continue;
        if (existingIds.has(t.mid) || t.isPrivate || (t.originalTweetId && !t.originalTweet)) continue;
        if ((t.timestamp as number) <= topTimestamp) continue;
        if (t.author && !seen.has(t.author.mid)) {
            seen.add(t.author.mid);
            authors.push(t.author);
            if (authors.length >= 3) break;
        }
    }
    return authors;
});

// Prepend newer tweets (and append older ones) from the store into the displayed list.
// `unshift` is safe here without scroll compensation: every caller either runs at
// scrollTop == 0 (cold mount / onActivated) or calls window.scrollTo({ top: 0 })
// immediately after (showPendingTweets). There is no mid-session direct-prepend path,
// so the viewport is never left pointing at shifted content.
function appendNewToDisplayed() {
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const topTimestamp = displayedTweets.value.length > 0
        ? (displayedTweets.value[0].timestamp as number)
        : Infinity;

    const newTweets = tweetStore.tweets
        .filter(e => {
            if (existingIds.has(e.mid)) return false;
            if (!tweetStore.feedTweetIds.has(e.mid)) return false;
            return !e.isPrivate && (!e.originalTweetId || e.originalTweet !== null);
        })
        .sort((a, b) => (b.timestamp as number) - (a.timestamp as number));

    if (newTweets.length === 0) return;

    const newer = newTweets.filter(t => (t.timestamp as number) > topTimestamp);
    const older = newTweets.filter(t => (t.timestamp as number) <= topTimestamp);
    if (newer.length > 0) displayedTweets.value.unshift(...newer);
    if (older.length > 0) displayedTweets.value.push(...older);
}

async function showPendingTweets() {
    hideBanner();
    const before = displayedTweets.value.length;
    appendNewToDisplayed();
    if (displayedTweets.value.length === before) {
        pageNumber.value = 0;
        hasMoreTweets.value = true;
        await loadMoreTweets();
    }
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
        <Transition name="tweet-banner">
            <div v-if="pendingCount > 0 && bannerVisible" class="new-tweets-banner" @click="showPendingTweets">
                <svg class="banner-arrow" viewBox="0 0 12 14" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6 13V1M6 1L1 6M6 1L11 6" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <div v-if="pendingAuthors.length > 0" class="banner-avatars">
                    <img v-for="(author, i) in pendingAuthors" :key="author.mid"
                         :src="author.avatar"
                         class="banner-avatar"
                         :style="{ marginLeft: i > 0 ? '-8px' : '0', zIndex: 3 - i }"/>
                </div>
                <span class="banner-text">{{ $t('tweet.showNewTweets', pendingCount) }}</span>
            </div>
        </Transition>
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
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 7px;
    height: 38px;
    padding: 0 14px 0 12px;
    background: rgba(29, 155, 240, 0.86);
    border-radius: 19px;
    border: none;
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.12);
    cursor: pointer;
    white-space: nowrap;
    max-width: calc(100vw - 40px);
    user-select: none;
}
.new-tweets-banner:active {
    background: rgba(29, 155, 240, 0.96);
}
.banner-arrow {
    flex-shrink: 0;
}
.banner-avatars {
    display: flex;
    align-items: center;
    flex-shrink: 0;
}
.banner-avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1.5px solid rgba(255, 255, 255, 0.5);
    object-fit: cover;
    position: relative;
}
.banner-text {
    color: white;
    font-size: 15px;
    font-weight: 400;
    line-height: 1;
}
.tweet-banner-enter-active {
    transition: opacity 0.22s ease-out, transform 0.22s ease-out;
}
.tweet-banner-leave-active {
    transition: opacity 0.15s ease-in, transform 0.15s ease-in;
}
.tweet-banner-enter-from {
    opacity: 0;
    transform: translateX(-50%) translateY(-10px);
}
.tweet-banner-leave-to {
    opacity: 0;
    transform: translateX(-50%) translateY(-10px);
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
