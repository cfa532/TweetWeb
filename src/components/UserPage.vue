<script setup lang='ts'>
import { onMounted, ref, onUnmounted, watch, computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { LOAD_TIMEOUT_MS, MAX_REFRESH_ATTEMPTS } from '@/constants';
import { USER_PAGE_SCROLL_PREFIX } from '@/constants/scrollRestore';
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
const router = useRouter();
const authorId = computed(() => route.params.authorId as MimeiId);
const pinnedTweets = ref<Tweet[]>([]);
const pageSize = 5; // Using the same page size as MainPage
const initialLoad = ref(true);
const hasMoreTweets = ref(true); // Flag to track if more tweets are available
const loadError = ref(''); // Error message to display when loading fails
let lastErrorTime = 0;

function isNearBottom(threshold = scrollThreshold) {
    const scrollBottom = window.innerHeight + window.scrollY;
    const docHeight = document.documentElement.scrollHeight;
    return docHeight - scrollBottom <= threshold;
}

/** After a page loads, scroll position is unchanged — no scroll event. Chain loads while still near the bottom. */
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

function restoreUserPageScroll(authorId: MimeiId) {
    const raw = sessionStorage.getItem(USER_PAGE_SCROLL_PREFIX + authorId)
    if (raw === null) {
        window.scrollTo(0, 0)
        return
    }
    const y = parseInt(raw, 10)
    if (Number.isNaN(y)) {
        window.scrollTo(0, 0)
        return
    }
    const apply = () => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
        window.scrollTo(0, Math.min(Math.max(0, y), maxScroll))
    }
    // Layout grows after tweets/images paint — retry so we don't clamp to 0.
    nextTick(() => {
        requestAnimationFrame(() => {
            apply()
            requestAnimationFrame(apply)
        })
        setTimeout(apply, 50)
        setTimeout(apply, 200)
    })
}

function saveUserPageScrollPosition() {
    const id = authorId.value
    if (id) {
        sessionStorage.setItem(USER_PAGE_SCROLL_PREFIX + id, String(window.scrollY))
    }
}

const SCROLL_TWEET_MAX_PAGES = 40

async function clearScrollTweetQuery() {
    const q = { ...route.query } as Record<string, string | string[]>
    delete q.scrollTweet
    await router.replace({ path: route.path, query: q })
}

function findTweetScrollTarget(tweetId: string): HTMLElement | null {
    const esc =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(tweetId)
            : tweetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const byData = document.querySelector(`[data-tweet-mid="${esc}"]`)
    if (byData instanceof HTMLElement) return byData
    return document.getElementById(tweetId)
}

/** Scroll to a tweet card on the profile (TweetView: data-tweet-mid + id on card-body). */
async function tryScrollToTweet(tweetId: MimeiId) {
    const attempt = () => {
        const el = findTweetScrollTarget(tweetId)
        if (!el) return false
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return true
    }
    const tryAfterPaint = async () => {
        await nextTick()
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        return attempt()
    }
    if (await tryAfterPaint()) {
        await clearScrollTweetQuery()
        return
    }
    let pages = 0
    while (hasMoreTweets.value && pages < SCROLL_TWEET_MAX_PAGES) {
        pages++
        await loadMoreTweets()
        if (await tryAfterPaint()) {
            await clearScrollTweetQuery()
            return
        }
    }
    await clearScrollTweetQuery()
}

async function maybeScrollOrRestoreProfile(nv: MimeiId, ov: MimeiId | undefined) {
    const raw = route.query.scrollTweet
    const tid = raw === undefined || raw === null ? undefined : Array.isArray(raw) ? raw[0] : raw
    if (tid) {
        await tryScrollToTweet(tid as MimeiId)
        return
    }
    if (ov !== undefined && nv !== ov) {
        window.scrollTo(0, 0)
    } else {
        restoreUserPageScroll(nv)
    }
}

// Save while still on this route — onUnmounted runs after the next view mounts,
// so window.scrollY is often already 0 (detail page scrolled to top).
onBeforeRouteLeave(() => {
    saveUserPageScrollPosition()
})

onMounted(() => {
    nextTick(() => setupLoadMoreObserver());
});

onUnmounted(() => {
    loadMoreObserver?.disconnect();
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
                    // Keep provider/avatar in sync so cached pinned tweets don't keep stale hosts.
                    if (ft.provider) existing.provider = ft.provider;
                    if (ft.author) {
                        if (!existing.author) existing.author = ft.author;
                        else {
                            if (ft.author.providerIp) existing.author.providerIp = ft.author.providerIp;
                            if (ft.author.avatar) existing.author.avatar = ft.author.avatar;
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
        // Keep cached pinned tweets on error instead of wiping them
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

            let loadedPageSize: number | null;
            try {
                loadedPageSize = await Promise.race([loadPromise, timeoutPromise]) as number | null;
                sessionStorage.removeItem('userPageRefreshCount');
            } catch (error) {
                // Timeout already handled the refresh; any other thrown error means stop.
                console.error('Unexpected error during load:', error);
                break;
            }

            round++;

            if (loadedPageSize === null) {
                // loadTweetsByUser returns null only when the user record cannot be
                // resolved (e.g. user not found). Nothing to retry — stop.
                console.warn('Could not load tweets: user not found or unrecoverable error.');
                break;
            }

            if (loadedPageSize === 0) {
                // Server returned success but no tweets — we have reached the end of
                // this user's timeline. Stop paging.
                console.log('No more tweets available from backend. Page number:', pageNumber.value);
                hasMoreTweets.value = false;
                break;
            }

            tweetsLoaded += loadedPageSize;

            // If fewer tweets than the full page were returned there are no more pages.
            if (loadedPageSize < pageSize) {
                console.log('Last page reached. Total loaded:', tweetsLoaded);
                hasMoreTweets.value = false;
                break;
            }

            pageNumber.value++;
            console.log('Loaded', tweetsLoaded, 'tweets so far. Next page:', pageNumber.value);

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
        scheduleLoadMoreIfStillNearBottom();
    }
}

async function loadMoreTweets() {
    if (isLoading.value || !hasMoreTweets.value) return;

    isLoading.value = true;
    loadError.value = '';

    try {
        const tweetsLoaded = await tweetStore.loadTweetsByUser(authorId.value, pageNumber.value, pageSize);

        if (tweetsLoaded && tweetsLoaded > 0) {
            // A full page means there may be another page; only a short page is the end.
            if (tweetsLoaded < pageSize) {
                hasMoreTweets.value = false;
            }
            pageNumber.value++;
        } else {
            console.log('No more tweets available from backend');
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

    const pinnedIds = new Set(pinnedTweets.value.map(t => t.mid));
    const newTweets = tweetStore.tweets
        .filter(e => {
            if (existingIds.has(e.mid)) return false;
            if (pinnedIds.has(e.mid)) return false;
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
    const pinnedIds = new Set(pinnedTweets.value.map(t => t.mid));
    const count = tweetStore.tweets.filter(e => {
        if (existingIds.has(e.mid)) return false;
        if (pinnedIds.has(e.mid)) return false;
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
    loadError.value = '';
    initialLoad.value = true;

    // Show cached tweets instantly while fresh data loads
    pinnedTweets.value = tweetStore.getCachedPinnedTweets(nv);
    const cached = tweetStore.getCachedUserTweets(nv);
    const pinnedIds = new Set(pinnedTweets.value.map(t => t.mid));
    displayedTweets.value = cached.filter(t => !pinnedIds.has(t.mid));
    if (cached.length > 0) {
        console.log(`Showing ${cached.length} cached tweets for ${nv}`);
    }

    // Force-refresh user data from its host (keeps cache for instant display
    // while fetching fresh data; avoids extra get_provider_ips RPC that removeUser causes)
    tweetStore.getUser(nv, true).then(u => {
        console.log(`[UserPage] providerIp for ${nv}:`, u?.providerIp ?? 'not resolved')
    });
    await initialLoadTweets(nv);
    // Deep link to a tweet, or restore list position / scroll top on author switch
    await maybeScrollOrRestoreProfile(nv, ov)
}, { immediate: true });

onBeforeRouteUpdate(async (to, from) => {
    const raw = to.query.scrollTweet
    const tid = raw === undefined || raw === null ? undefined : Array.isArray(raw) ? raw[0] : raw
    if (!tid) return
    // Author change is handled by the authorId watch after tweets load
    if (to.params.authorId !== from.params.authorId) return
    while (isLoading.value) {
        await new Promise((r) => setTimeout(r, 40))
    }
    await tryScrollToTweet(tid as MimeiId)
});

watch(displayedTweets, () => nextTick(() => setupLoadMoreObserver()), { flush: 'post' });
</script>

<template>
    <PageLayout>
        <AppHeader :userId='authorId' />
        <b v-if='pinnedTweets?.length!>0' style='color: #8899a6;'>&nbsp;&nbsp;{{ $t('profile.pinned') }}</b>
        <TweetView v-for='tweet in pinnedTweets' :tweet='tweet' :key="'pinned-' + tweet.mid"/>
        <hr v-if='pinnedTweets?.length!>0' />
        <b v-if='pinnedTweets?.length!>0' style='color: #8899a6;'>&nbsp;&nbsp;{{ $t('profile.tweets') }}</b>
        <div v-if="pendingCount > 0" class="new-tweets-banner" @click="showPendingTweets">
            {{ $t('tweet.showNewTweets', pendingCount) }}
        </div>
        <TweetView v-for='tweet in displayedTweets' :tweet='tweet' :key='tweet.mid'/>
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