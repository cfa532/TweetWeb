<script setup lang='ts'>
import { onMounted, onActivated, onDeactivated, ref, onUnmounted, watch, computed, nextTick } from 'vue';
defineOptions({ name: 'UserPage' })
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router';
import { LOAD_TIMEOUT_MS } from '@/constants';
import { AppHeader } from '@/views';
import { isBrowserReload, isWeChatBrowser, shouldResyncUser } from '@/lib';
import { LoadingSpinner, PageLayout, TweetList } from '@/components';
import { useScrollRestore } from '@/composables/useScrollRestore';
import { startFeedPolling } from '@/composables/useFeedPolling';

const { t } = useI18n();

const tweetStore = useTweetStore();
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
const isLoading = ref(false);
const retryMessage = ref('');
const pageNumber = ref(0);
const scrollThreshold = 200; // Distance from bottom to trigger load
const route = useRoute();
const router = useRouter();
const authorId = computed(() => route.params.authorId as MimeiId);
// Capture the document's original route once. UserPage is kept alive, so the
// global navigation type alone must not make later profile switches recover.
const reloadRecoveryAuthorId = isBrowserReload() ? authorId.value : undefined;
const recoveredProfileIds = new Set<MimeiId>();
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

function isAtTop(threshold = 8) {
    return window.scrollY <= threshold;
}

/** After a page loads, scroll position is unchanged — no scroll event. Chain loads while still near the bottom. */
function scheduleLoadMoreIfStillNearBottom() {
    if (userView.value !== 'tweets') return;
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
            if (userView.value !== 'tweets') return;
            if (isLoading.value || !hasMoreTweets.value) return;
            if (lastErrorTime && Date.now() - lastErrorTime < 2000) return;
            if (isRestoringFeed.value) return;
            void loadMoreTweets();
        },
        { root: null, rootMargin: '0px 0px 320px 0px', threshold: 0 },
    );
    loadMoreObserver.observe(el);
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

// Deep link to a specific tweet on the profile (scrollTweet query). Normal scroll
// position on back-navigation is preserved by <keep-alive> + the router's saved
// scroll position, so no manual restore is needed here.
async function maybeScrollToDeepLinkedTweet() {
    const raw = route.query.scrollTweet
    const tid = raw === undefined || raw === null ? undefined : Array.isArray(raw) ? raw[0] : raw
    if (tid) {
        await tryScrollToTweet(tid as MimeiId)
    }
}

onMounted(() => {
    nextTick(() => setupLoadMoreObserver());
    startFeedPolling();
    // Scrolling back to the top consumes pending tweets directly and drops the banner.
    window.addEventListener('scroll', onWindowScroll, { passive: true });
});

onUnmounted(() => {
    loadMoreObserver?.disconnect();
    window.removeEventListener('scroll', onWindowScroll);
    hideBanner();
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
                // Don't reload the page — cached pinned tweets are already shown.
                // Just give up the fresh refresh and let the user keep the cached view.
                console.warn(`[UserPage] Pinned tweets timeout after ${LOAD_TIMEOUT_MS}ms; keeping cached view`);
                reject(new Error('Pinned tweets timeout'));
            }, LOAD_TIMEOUT_MS);
        });

        const freshPinned = await Promise.race([pinnedPromise, pinnedTimeout]);
        if (route.params.authorId !== authorId) return;
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
                    // Per-appUser flags ([favorite, bookmark, retweeted]) — ref
                    // comparison would always differ on a new array, so always
                    // overwrite when the server provided a value.
                    if (ft.favorites !== undefined) {
                        existing.favorites = ft.favorites;
                    }
                    const referenceId = (mid: string) => {
                        const value = String(mid || '').trim();
                        const separator = value.lastIndexOf('/');
                        return separator >= 0 ? value.substring(separator + 1) : value;
                    };
                    const freshAttachmentIds = (ft.attachments || []).map(attachment => referenceId(attachment.mid));
                    const existingAttachmentIds = (existing.attachments || []).map(attachment => referenceId(attachment.mid));
                    const attachmentSetChanged = JSON.stringify(freshAttachmentIds) !== JSON.stringify(existingAttachmentIds);
                    const cachedMediaNeedsUrls = (existing.attachments || []).some(attachment =>
                        !/^https?:\/\//i.test(attachment.mid)
                    );
                    if (attachmentSetChanged || cachedMediaNeedsUrls) {
                        existing.attachments = ft.attachments;
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
    let loadSucceeded = false;
    const firstPageNumber = pageNumber.value;
    const startedAtTop = isAtTop();
    const loadedCandidateIds = new Set<string>();

    // Start loading pinned tweets in parallel with regular tweets so the pinned
    // video (shown first on the page) gets priority bandwidth.
    const pinnedPromiseOuter = loadPinnedTweetsForUser(authorId);

    try {
        // Keep loading a couple of pages for first paint, but do not let initial
        // profile render chain many retry windows when nodes are slow.
        const minTweets = 6;
        const maxInitialRounds = 3;
        let tweetsLoaded = 0;
        let round = 0;
        while (isLoading.value && round < maxInitialRounds) {
            // Add timeout to each page load - timeout, refresh immediately on timeout (max attempts)
            const refreshCount = parseInt(sessionStorage.getItem('userPageRefreshCount') || '0');

            let hasTimedOut = false;
            const pageCandidateIds = new Set<string>();
            const loadPromise = tweetStore.loadTweetsByUser(authorId, pageNumber.value, pageSize, {
                candidateIds: pageCandidateIds,
            }).then(result => {
                pageCandidateIds.forEach(id => loadedCandidateIds.add(id));
                // Clear timeout immediately when load succeeds
                if (currentTimeoutId && !hasTimedOut) {
                    clearTimeout(currentTimeoutId);
                }
                return result;
            });

            // Time out the page-load round, but keep the cached view in place.
            const timeoutPromise = new Promise<never>((_, reject) => {
                currentTimeoutId = window.setTimeout(() => {
                    hasTimedOut = true;
                    console.warn(`[UserPage] Page load timeout after ${LOAD_TIMEOUT_MS}ms; keeping cached view`);
                    isLoading.value = false;
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
            loadSucceeded = true;

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
        // Reconcile only when the network load succeeded — if it failed entirely
        // (node unreachable, timeout) keep cached tweets on screen.
        if (loadSucceeded) {
            const storeIds = new Set(tweetStore.tweets.map(t => t.mid));
            const filtered = displayedTweets.value.filter(t => !t.parentTweetId && storeIds.has(t.mid));
            if (filtered.length !== displayedTweets.value.length) {
                displayedTweets.value = filtered;
            }
        }
        if (firstPageNumber !== 0 || startedAtTop) {
            appendNewToDisplayed(loadedCandidateIds);
        }
        isLoading.value = false;
        initialLoad.value = false;
        scheduleLoadMoreIfStillNearBottom();
    }
}

async function loadMoreTweets() {
    if (userView.value !== 'tweets') return;
    if (isLoading.value || !hasMoreTweets.value) return;

    isLoading.value = true;
    loadError.value = '';
    const loadedPageNumber = pageNumber.value;
    const pageCandidateIds = new Set<string>();
    const routePageZeroToBanner = loadedPageNumber === 0 && !isAtTop();

    try {
        const tweetsLoaded = await tweetStore.loadTweetsByUser(authorId.value, loadedPageNumber, pageSize, {
            candidateIds: pageCandidateIds,
        });

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
        if (!routePageZeroToBanner) {
            appendNewToDisplayed(pageCandidateIds);
        }
        isLoading.value = false;
        scheduleLoadMoreIfStillNearBottom();
    }
}

// Persist & restore this profile's scroll position, keyed per-author so one
// user's spot never bleeds onto another's. Back-nav restores synchronously
// (keep-alive DOM); reload pages content in then jumps. See useScrollRestore.
const { restoring: isRestoringFeed, restoreAfterLoad, hasDeepSavedScroll } = useScrollRestore(
    () => `userPage:${authorId.value}`,
    {
        hasMore: () => hasMoreTweets.value,
        loadMore: loadMoreTweets,
        skipRestore: () => route.query.scrollTweet != null,
    },
);

// UserPage is keep-alive. Returning from TweetDetail with ?scrollTweet= only
// changes the query — authorId does not change, so the authorId watch does not
// re-run. Handle that activation here (onBeforeRouteUpdate does not fire when
// the component was deactivated for TweetDetail).
onActivated(async () => {
    const raw = route.query.scrollTweet
    const tid = raw === undefined || raw === null ? undefined : Array.isArray(raw) ? raw[0] : raw
    if (!tid) return
    while (isLoading.value) {
        await new Promise((r) => setTimeout(r, 40))
    }
    await tryScrollToTweet(tid as MimeiId)
});

const displayedTweets = ref<Tweet[]>([]);
// The global store also holds this author's OLDER tweets pulled in by other
// flows (home feed, feed polling, bookmarks/favorites) that profile pagination
// simply hasn't reached yet. Only tweets strictly newer than the newest
// displayed tweet are genuinely "new" for the banner.
function pendingNewTweetIds(): Set<string> {
    const ids = new Set<string>();
    if (initialLoad.value) return ids;
    const existingIds = new Set(displayedTweets.value.map(t => t.mid));
    const pinnedIds = new Set(pinnedTweets.value.map(t => t.mid));
    const topTimestamp = displayedTweets.value.length > 0
        ? (displayedTweets.value[0].timestamp as number)
        : -Infinity;
    for (const e of tweetStore.tweets) {
        if (e.parentTweetId) continue;
        if (existingIds.has(e.mid)) continue;
        if (pinnedIds.has(e.mid)) continue;
        if ((e.timestamp as number) <= topTimestamp) continue;
        const isAuthorMatch = e.isPrivate
            ? tweetStore.loginUser?.mid === e.authorId && e.authorId === authorId.value
            : e.authorId === authorId.value;
        if (isAuthorMatch && (!e.originalTweetId || e.originalTweet !== null)) {
            ids.add(e.mid);
        }
    }
    return ids;
}
const pendingCount = computed(() => pendingNewTweetIds().size);
const profilePendingCountLabel = computed(() => pendingCount.value > 9 ? '9+' : String(pendingCount.value));
const profilePendingBannerText = computed(() => t(
    pendingCount.value === 1 ? 'tweet.showNewTweetCapped' : 'tweet.showNewTweetsCapped',
    { count: profilePendingCountLabel.value },
));
function handlePendingBannerClick() {
    showPendingTweets();
}
// New tweets render directly (no banner) while the list is already at the top;
// the banner is only for a viewport somewhere in the middle of the list, where
// a direct prepend would shift the content under the reader.
function canRenderPendingDirectly() {
    return isPageActive.value
        && userView.value === 'tweets'
        && !isRestoringFeed.value
        && isAtTop();
}
function consumePendingAtTop() {
    hideBanner();
    appendNewToDisplayed(pendingNewTweetIds());
}
watch(pendingCount, (count, prev) => {
    if (count === 0) { hideBanner(); return; }
    if (canRenderPendingDirectly()) { consumePendingAtTop(); return; }
    if (prev === 0 || !bannerVisible.value) showBanner();
});
function onWindowScroll() {
    if (pendingCount.value > 0 && canRenderPendingDirectly()) consumePendingAtTop();
}
// Keep-alive: the pendingCount watch also fires while this page is deactivated
// (feed polling keeps filling the store). isPageActive stops it from reading
// another page's scroll position and appending into a hidden list.
const isPageActive = ref(true);
onActivated(() => {
    isPageActive.value = true;
    if (pendingCount.value > 0 && canRenderPendingDirectly()) consumePendingAtTop();
});
onDeactivated(() => { isPageActive.value = false; });
// The authorId this profile has already loaded. Survives the route hop through
// /media-viewer (where authorId becomes undefined), unlike the watch's
// oldValue — so returning to the same user doesn't re-fetch the whole profile.
const loadedForUser = ref<string | null>(null);

// Active view tab from AppHeader: undefined / 'tweets' = user's own tweets,
// 'bookmarks' / 'favorites' fetch via get_user_meta and replace the body.
const userView = computed<'tweets' | 'bookmarks' | 'favorites'>(() => {
    const v = route.query.view
    return v === 'bookmarks' || v === 'favorites' ? v : 'tweets'
});

const metaTweets = ref<Tweet[]>([]);
const isMetaLoading = ref(false);

watch(
    () => [route.params.authorId, userView.value] as const,
    async ([uid, view]) => {
        if (view === 'tweets' || !uid) {
            metaTweets.value = []
            return
        }
        const type = view === 'bookmarks' ? 'bookmark_list' : 'favorite_list'
        isMetaLoading.value = true
        try {
            metaTweets.value = await tweetStore.loadUserTweetsByType(uid as string, type)
        } catch (e) {
            console.warn('[UserPage] loadUserTweetsByType failed:', e)
            metaTweets.value = []
        } finally {
            isMetaLoading.value = false
        }
    },
    { immediate: true }
);

function appendNewToDisplayed(candidateIds?: Set<string>) {
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
            if (e.parentTweetId) return false;
            if (existingIds.has(e.mid)) return false;
            if (pinnedIds.has(e.mid)) return false;
            if (candidateIds && !candidateIds.has(e.mid)) return false;
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
    hideBanner();
    // Append only the tweets the banner counted — an unfiltered append would
    // also splice the author's older store tweets (from the home feed etc.)
    // into the bottom of the list, out of order with pagination.
    appendNewToDisplayed(pendingNewTweetIds());
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function recoverReloadedProfile(targetAuthorId: MimeiId) {
    if (recoveredProfileIds.has(targetAuthorId)) return;
    recoveredProfileIds.add(targetAuthorId);

    try {
        // Use the existing route when available. A cache miss performs the one
        // user read needed to discover the access node before synchronization.
        const currentUser = await tweetStore.getUser(targetAuthorId);
        if (!currentUser) return;
        if (!shouldResyncUser(currentUser)) {
            console.log(`[UserPage] Skipping resync_user for ${targetAuthorId}: read/root nodes do not differ`);
            return;
        }

        console.log(`[UserPage] Calling resync_user for ${targetAuthorId}`);
        const result = await tweetStore.resyncUser(targetAuthorId);
        console.log(`[UserPage] Completed resync_user for ${targetAuthorId}; synchronized tweets: ${result.tweets.length}`);
        if (authorId.value !== targetAuthorId || userView.value !== 'tweets') return;

        const syncedIds = new Set(result.tweets.map(t => t.mid));
        appendNewToDisplayed(syncedIds);
    } catch (error) {
        console.warn(`[UserPage] Reload recovery resync failed for ${targetAuthorId}:`, error);
    }
}

// Remove deleted tweets from the feed immediately. (Additions are reflected by
// the pendingCount computed, so they don't need handling here.)
watch(() => tweetStore.tweets.length, (newLen, oldLen) => {
    if (newLen < oldLen) {
        const storeIds = new Set(tweetStore.tweets.map(t => t.mid));
        displayedTweets.value = displayedTweets.value.filter(t => storeIds.has(t.mid));
    }
});

// Single entry point for loading profile tweets — covers initial mount, route
// changes, and switching back from bookmark/favorite views.
watch(() => [authorId.value, userView.value] as const, async ([nv, view]) => {
    if (!nv) return;

    if (view !== 'tweets') {
        loadError.value = '';
        retryMessage.value = '';
        hasMoreTweets.value = false;
        initialLoad.value = false;
        isLoading.value = false;
        isRestoringFeed.value = false;
        return;
    }

    if (nv === loadedForUser.value && view === 'tweets') return;
    loadedForUser.value = nv;

    console.log('UserPage loading authorId:', nv);
    // Each profile tracks its own new tweets — never carry banner state from
    // the previously viewed profile into this one.
    hideBanner();
    pageNumber.value = 0;
    hasMoreTweets.value = true;
    loadError.value = '';
    initialLoad.value = true;

    // Show cached tweets instantly while fresh data loads
    pinnedTweets.value = tweetStore.getCachedPinnedTweets(nv);
    const cached = tweetStore.getCachedUserTweets(nv);
    const pinnedIds = new Set(pinnedTweets.value.map(t => t.mid));
    displayedTweets.value = cached.filter(t => !t.parentTweetId && !pinnedIds.has(t.mid));
    if (cached.length > 0) {
        console.log(`Showing ${cached.length} cached tweets for ${nv}`);
    }

    // A browser reload is the Web profile's explicit recovery action. Finish
    // access-node synchronization before fresh pinned/timeline reads. Ordinary
    // SPA navigation keeps the normal cached route lookup and does not resync.
    if (reloadRecoveryAuthorId === nv) {
        await recoverReloadedProfile(nv);
        if (authorId.value !== nv || userView.value !== 'tweets') return;
    } else {
        tweetStore.getUserFromRootHost(nv, false).then(u => {
            console.log(`[UserPage] providerIp for ${nv}:`, u?.providerIp ?? 'not resolved')
        });
    }
    // A scrollTweet deep link owns the scroll target. Otherwise only hide the feed
    // while paging back to a previously saved deep scroll position; a fresh load
    // with no saved spot (e.g. tapping the Tweets tab) loads normally — no veil.
    const hasScrollTweet = route.query.scrollTweet != null;
    isRestoringFeed.value = !hasScrollTweet && hasDeepSavedScroll();
    await initialLoadTweets(nv);
    await maybeScrollToDeepLinkedTweet();
    if (!hasScrollTweet) await restoreAfterLoad();
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
        <div v-if="isRestoringFeed" class="feed-restoring-overlay" aria-live="polite">
            <LoadingSpinner />
        </div>

        <!-- Bookmarks / Favorites view: replaces pinned + own-tweets list. -->
        <template v-if="userView !== 'tweets'">
            <b style='color: #8899a6;'>&nbsp;&nbsp;{{ userView === 'bookmarks' ? $t('profile.bookmarks') : $t('profile.favorites') }}</b>
            <TweetList :tweets="metaTweets" />
            <div v-if='isMetaLoading' class='d-flex flex-column align-items-center justify-content-center gap-2 my-4 py-3'>
                <LoadingSpinner />
                <span class="small" style="color: #8899a6;">{{ $t('common.loading') }}</span>
            </div>
            <div v-else-if='metaTweets.length === 0' class='text-center my-4 small' style='color: #8899a6;'>
                {{ $t('tweet.noMorePosts') }}
            </div>
        </template>

        <!-- Default: user's own tweets (pinned + chronological). -->
        <template v-else>
            <b v-if='pinnedTweets?.length!>0' style='color: #8899a6;'>&nbsp;&nbsp;{{ $t('profile.pinned') }}</b>
            <TweetList :tweets="pinnedTweets" />
            <hr v-if='pinnedTweets?.length!>0' />
            <b v-if='pinnedTweets?.length!>0' style='color: #8899a6;'>&nbsp;&nbsp;{{ $t('profile.tweets') }}</b>
            <Transition name="tweet-banner">
                <div v-if="pendingCount > 0 && bannerVisible && tweetStore.loginUser" class="new-tweets-banner"
                     @click="handlePendingBannerClick">
                    <svg class="banner-arrow" viewBox="0 0 12 14" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M6 13V1M6 1L1 6M6 1L11 6" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="banner-text">{{ profilePendingBannerText }}</span>
                </div>
            </Transition>
            <div :class="{ 'feed-restoring': isRestoringFeed }">
                <TweetList :tweets="displayedTweets" />
            </div>
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
        </template>
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

/* While paging in content to reach a saved scroll offset (deep reload / author
   switch), keep the feed's layout for measurement but hide it so the top of the
   list never flashes before content catches up. */
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
