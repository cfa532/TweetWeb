<script lang="ts" setup>
import { ref, onMounted, onUnmounted, watch, computed, nextTick, triggerRef, provide } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from "@/stores";
import { AudioPlaylistPlayer, MediaView, DetailHeader, TweetView, TweetActionBar } from "@/views";
import { LoadingSpinner, PageLayout, TweetList } from "@/components";
import { normalizeMediaType, isBrowserReload, isWeChatBrowser, shouldResyncUser } from '@/lib';
import {
    APP_DOWNLOAD_FALLBACK_QUERY,
    APP_LINK_ORIGIN,
    TWEET_LIST_CONTENT_MAX_LINES,
} from '@/constants';

const { t } = useI18n();

const route = useRoute();
const router = useRouter();
const tweetStore = useTweetStore()

// Tells descendant VideoJS components to skip the feed playback coordinator
// gating — embedded quote-tweet videos on this page need to load eagerly
// instead of waiting for the coordinator's 50%-visible threshold.
provide('isInTweetDetailPage', true)

const tweetId = computed(()=>route.params.tweetId as MimeiId)
const authorId = computed(()=>route.params.authorId as MimeiId | undefined)
const tweet = ref()
const originTweet = ref()
const isRetweet = ref(false)
const isLoading = ref(false)
const loadError = ref(false)
const tweetNotFound = ref(false)
const hasLoadAttempted = ref(false)
// TweetDetail can be reused for later detail routes; only the route that was
// present during the document reload owns this recovery trigger.
const reloadRecoveryTweetId = isBrowserReload() ? tweetId.value : undefined

function tweetHasOwnBody(tweetValue: Tweet | null | undefined): boolean {
    if (!tweetValue) return false
    if (typeof tweetValue.title === 'string' && tweetValue.title.trim()) return true
    if (typeof tweetValue.content === 'string' && tweetValue.content.trim()) return true
    return Array.isArray(tweetValue.attachments) && tweetValue.attachments.length > 0
}

// Open-in-app prompt variables
const showDownloadPrompt = ref(false)
let viewportInsetRefreshTimer: number | null = null

function updateDownloadButtonViewportInset() {
    const viewport = window.visualViewport
    if (!viewport) return

    const visibleBottom = viewport.offsetTop + viewport.height
    const browserBottomInset = Math.max(0, window.innerHeight - visibleBottom)
    document.documentElement.style.setProperty(
        '--tweet-detail-browser-bottom-inset',
        `${browserBottomInset}px`
    )
}

function refreshDownloadButtonViewportInset() {
    updateDownloadButtonViewportInset()
    window.requestAnimationFrame(() => updateDownloadButtonViewportInset())
    if (viewportInsetRefreshTimer) clearTimeout(viewportInsetRefreshTimer)
    viewportInsetRefreshTimer = window.setTimeout(() => {
        updateDownloadButtonViewportInset()
        viewportInsetRefreshTimer = null
    }, 250)
}

// Draggable button state
const btnEl = ref<HTMLElement | null>(null)
const btnPos = ref({ x: 0, y: 0 })
const btnInitialized = ref(false)
const isDragging = ref(false)
const lastDragPos = ref({ x: 0, y: 0 })
const dragMoved = ref(false)

function initBtnPos() {
    if (btnInitialized.value) return
    const rect = btnEl.value?.getBoundingClientRect()
    if (rect) {
        btnPos.value = { x: rect.left, y: rect.top }
    } else {
        btnPos.value = { x: window.innerWidth / 2 - 80, y: window.innerHeight - 100 }
    }
    btnInitialized.value = true
}

function onDragStart(e: MouseEvent | TouchEvent) {
    initBtnPos()
    isDragging.value = true
    dragMoved.value = false
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    lastDragPos.value = { x: clientX, y: clientY }
    e.preventDefault()
    window.addEventListener('mousemove', onWindowDragMove)
    window.addEventListener('mouseup', onWindowDragEnd)
    window.addEventListener('touchmove', onWindowDragMove, { passive: false })
    window.addEventListener('touchend', onWindowDragEnd)
}

function onWindowDragMove(e: MouseEvent | TouchEvent) {
    if (!isDragging.value) return
    const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX
    const clientY = 'touches' in e ? (e as TouchEvent).touches[0].clientY : (e as MouseEvent).clientY
    btnPos.value = {
        x: btnPos.value.x + clientX - lastDragPos.value.x,
        y: btnPos.value.y + clientY - lastDragPos.value.y,
    }
    lastDragPos.value = { x: clientX, y: clientY }
    dragMoved.value = true
    e.preventDefault()
}

function onWindowDragEnd() {
    if (!isDragging.value) return
    isDragging.value = false
    window.removeEventListener('mousemove', onWindowDragMove)
    window.removeEventListener('mouseup', onWindowDragEnd)
    window.removeEventListener('touchmove', onWindowDragMove)
    window.removeEventListener('touchend', onWindowDragEnd)
    if (!dragMoved.value) {
        openInApp()
    }
}


onMounted(async () => {
    refreshDownloadButtonViewportInset()
    window.visualViewport?.addEventListener('resize', updateDownloadButtonViewportInset)
    window.visualViewport?.addEventListener('scroll', updateDownloadButtonViewportInset)
    window.addEventListener('resize', updateDownloadButtonViewportInset)

    // dtweet.com opens the native app when it is installed. Its browser
    // fallback preserves the path and query, so only an unhandled web
    // navigation reaches this branch and continues to the download page.
    if (route.query[APP_DOWNLOAD_FALLBACK_QUERY] === '1') {
        await router.replace({ name: 'apk' })
        return
    }

    if (sessionStorage["isBot"] != "No" && isWeChatBrowser()) {
        if (confirm(t('botVerification'))) {
            sessionStorage["isBot"] = "No"
            loadDetail()
        } else {
            history.go(-1)
        }
    } else {
        // For non-WeChat browsers, automatically pass verification
        if (sessionStorage["isBot"] != "No") {
            sessionStorage["isBot"] = "No"
        }
        loadDetail()
    }

    // Show download button after 2 seconds, hide it again 30 seconds later
    setTimeout(() => {
        showDownloadPrompt.value = true
        refreshDownloadButtonViewportInset()
        setTimeout(() => {
            showDownloadPrompt.value = false
        }, 30000)
    }, 2000)
});
// Bumped on every loadDetail() call so a stale in-flight attempt can recognize
// that it has been superseded by a user-triggered retry or route change.
let loadGeneration = 0
const DETAIL_FETCH_RETRY_DELAY_MS = 8000
// A request that fails outright (rather than hanging) is retried well before the
// timer above, but not instantly: back-to-back attempts against a node that is
// still waking both fail, and the error UI appears within a second of opening
// the page. One short pause is enough to let a cold route come up.
const DETAIL_FETCH_FAILURE_RETRY_DELAY_MS = 1200

type DetailFetchOutcome = {
    tweet: Tweet | null
    error?: unknown
}

// Start exactly one retry if the initial request has not produced a tweet
// within eight seconds. The first successful request wins; failures are only
// surfaced after both requests have finished.
function fetchTweetWithSingleRetry(
    request: (refreshProviderRoute: boolean) => Promise<Tweet | null>,
    myGeneration: number,
    label: string
): Promise<Tweet | null> {
    return new Promise((resolve, reject) => {
        let settled = false
        let retryStarted = false
        let retryTimer: number | undefined
        const outcomes: [DetailFetchOutcome | undefined, DetailFetchOutcome | undefined] = [undefined, undefined]

        const startRetry = (reason: string, delayMs: number = 0) => {
            if (settled || retryStarted) return
            if (myGeneration !== loadGeneration) {
                settled = true
                resolve(null)
                return
            }

            retryStarted = true
            if (retryTimer !== undefined) clearTimeout(retryTimer)
            console.warn(`[TweetDetail] ${label} ${reason}; retrying with fresh provider discovery${delayMs > 0 ? ` in ${delayMs}ms` : ''}`)

            const begin = () => {
                if (settled) return
                if (myGeneration !== loadGeneration) {
                    settled = true
                    resolve(null)
                    return
                }
                void runAttempt(1)
            }

            if (delayMs > 0) {
                retryTimer = window.setTimeout(begin, delayMs)
            } else {
                begin()
            }
        }

        const finishAttempt = (attempt: number, outcome: DetailFetchOutcome) => {
            if (settled) return
            if (myGeneration !== loadGeneration) {
                settled = true
                if (retryTimer !== undefined) clearTimeout(retryTimer)
                resolve(null)
                return
            }

            outcomes[attempt] = outcome
            if (outcome.tweet) {
                settled = true
                if (retryTimer !== undefined) clearTimeout(retryTimer)
                resolve(outcome.tweet)
                return
            }

            // A fast null/error retries well before the slow-request timer, but
            // after a short pause — see DETAIL_FETCH_FAILURE_RETRY_DELAY_MS.
            if (attempt === 0 && !retryStarted) {
                startRetry('initial request failed', DETAIL_FETCH_FAILURE_RETRY_DELAY_MS)
            }

            const initialOutcome = outcomes[0]
            const retryOutcome = outcomes[1]
            if (initialOutcome && retryOutcome) {
                settled = true
                if (retryTimer !== undefined) clearTimeout(retryTimer)
                if ('error' in retryOutcome) {
                    reject(retryOutcome.error)
                } else {
                    resolve(null)
                }
            }
        }

        const runAttempt = async (attempt: number) => {
            try {
                finishAttempt(attempt, { tweet: await request(attempt === 1) })
            } catch (error) {
                finishAttempt(attempt, { tweet: null, error })
            }
        }

        retryTimer = window.setTimeout(() => {
            startRetry(`did not load within ${DETAIL_FETCH_RETRY_DELAY_MS}ms`)
        }, DETAIL_FETCH_RETRY_DELAY_MS)

        void runAttempt(0)
    })
}

async function loadOriginalTweet(parentTweet: Tweet, myGeneration: number): Promise<Tweet | null> {
    if (parentTweet.originalTweet) return parentTweet.originalTweet
    if (!parentTweet.originalTweetId) return null
    const originalTweetId = parentTweet.originalTweetId
    const originalAuthorId = parentTweet.originalAuthorId

    return fetchTweetWithSingleRetry(
        (refreshProviderRoute) => tweetStore.fetchTweet(
            originalTweetId,
            originalAuthorId,
            true,
            false,
            true,
            false,
            refreshProviderRoute
        ),
        myGeneration,
        'Original tweet'
    )
}

async function loadDetail(options: { forceRouteRefresh?: boolean } = {}) {
    const myGeneration = ++loadGeneration

    isLoading.value = true
    loadError.value = false
    tweetNotFound.value = false
    hasLoadAttempted.value = true

    try {
        // Cold node resolution can be slow on first page load. Give the initial
        // request eight seconds, then start one fresh provider-route lookup.
        // The request layer owns its network timeouts; a separate UI timeout
        // used to expose an error while this retry was still in progress.
        const fetchedTweet = await fetchTweetWithSingleRetry(
            (refreshProviderRoute) => tweetStore.fetchTweet(
                tweetId.value,
                authorId.value,
                true,
                false,
                true,
                false,
                refreshProviderRoute || options.forceRouteRefresh === true
            ),
            myGeneration,
            'Tweet'
        )

        if (myGeneration !== loadGeneration) return

        if (!fetchedTweet) {
            throw new Error('Tweet not found (null response)')
        }

        tweet.value = fetchedTweet
        loadError.value = false
        await showTweet(myGeneration)
    } catch (error) {
        if (myGeneration !== loadGeneration) return
        console.error('[TweetDetail] Error loading tweet detail:', error)

        const isTweetNotFound = error && typeof error === 'object' && 'message' in error &&
                               (error as Error).message === 'Tweet not found (null response)'
        isLoading.value = false
        if (isTweetNotFound) {
            tweetNotFound.value = true
        } else {
            loadError.value = true
        }
    }
}
async function showTweet(myGeneration: number) {
    try {
        // Tweet content is ready to display - set loading to false early
        document.title = formattedTitle.value
        isLoading.value = false

        // Load comments and additional data in parallel (truly non-blocking)
        const loadPromises = []

        // Load original tweet if needed
        if (tweet.value.originalTweetId) {
            loadPromises.push((async () => {
                try {
                    // If the parent tweet came from cache it already carries
                    // its originalTweet; reuse it instead of refetching.
                    const loadedOriginal = await loadOriginalTweet(tweet.value, myGeneration)
                    if (myGeneration !== loadGeneration) return
                    originTweet.value = loadedOriginal
                    if (!tweetHasOwnBody(tweet.value) && originTweet.value) {
                        // Pure retweet (no added content): show the original's comments.
                        isRetweet.value = true
                        await tweetStore.loadComments(originTweet.value)
                    } else {
                        // Quote-retweet: comments belong to the outer tweet.
                        await tweetStore.loadComments(tweet.value)
                    }
                } catch (error) {
                    console.warn('[TweetDetail] Failed to load original tweet:', error)
                }
            })())
        } else {
            loadPromises.push((async () => {
                try {
                    await tweetStore.loadComments(tweet.value)
                } catch (error) {
                    console.warn('[TweetDetail] Failed to load comments:', error)
                }
            })())
        }

        // Await comments loading, then trigger Vue reactivity
        await Promise.allSettled(loadPromises)
        // A retry may have started (and possibly already finished) while the
        // above awaits were pending; bail out so this stale call doesn't
        // duplicate observers/timers on top of the newer attempt's.
        if (myGeneration !== loadGeneration) return
        // Use triggerRef to notify Vue that the ref's inner value has changed
        triggerRef(tweet)
        triggerRef(originTweet)

        // Reset pagination and attach IntersectionObserver for infinite-scroll comments
        commentPage.value = 0
        hasMoreComments.value = true
        setupCommentObserver()

        // Browser reload is Web's explicit recovery trigger. Start only after
        // content renders and never await it, so synchronization cannot block UI.
        if (reloadRecoveryTweetId === tweetId.value) void resyncDetailTweets()

        // Independent of the tweet-content resync above: poll for new comments
        // on a slower cadence, starting a short while after the initial load.
        const commentOwner = isRetweet.value ? originTweet.value : tweet.value
        if (commentOwner) startCommentRefreshLoop(commentOwner)
    } catch (error) {
        console.error('Error in showTweet:', error)
        isLoading.value = false
    }
};

const MAX_TITLE_LENGTH = 40
const formattedTitle = computed(() => {
    let title = tweet.value.title
    if (title)
        return title
    title = ""
    if (!tweetStore.isEmptyString(tweet.value.content)) {
        title = tweet.value.content!.substring(0, MAX_TITLE_LENGTH)
    } else {
        if (tweet.value.originalTweetId && tweet.value.originalTweet) {
            if (!tweetStore.isEmptyString(tweet.value.originalTweet.content)) {
                title = tweet.value.originalTweet.content!.substring(0, MAX_TITLE_LENGTH)
            } else {
                tweet.value.originalTweet.attachments?.forEach((element: any) => {
                    title += '[' + element.type + ']'
                });
            }
        } else {
            tweet.value.attachments?.forEach((element: any) => {
                title += '[' + element.type + ']'
            });
        }
    }
    return title
})



watch(tweetId, async (newValue, oldValue)=>{
    if (newValue && oldValue !== newValue) {
        // Clear current tweet and use the same loadDetail function with retry logic
        tweet.value = null
        originTweet.value = null
        isRetweet.value = false
        commentPage.value = 0
        hasMoreComments.value = true
        stopCommentRefreshLoop()
        await loadDetail()
    }
});

watch(route, () => {
    nextTick(() => {
        window.scrollTo(0, 0);
    });
});

function linkify(text: string) {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function openInApp() {
    if (isWeChatBrowser()) {
        window.alert(t('download.openInDefaultBrowser'))
        return
    }

    const appLink = new URL(route.path, APP_LINK_ORIGIN)
    appLink.searchParams.set(APP_DOWNLOAD_FALLBACK_QUERY, '1')
    window.location.assign(appLink.toString())
}

function isVideoMedia(media?: MimeiFileType) {
    const type = media?.type?.toLowerCase() || ''
    return type.includes('video') || type === 'hls_video'
}

function shouldAutoplay(media: MimeiFileType, mediaList?: MimeiFileType[]) {
    // Only autoplay on desktop
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (hasTouch && window.innerWidth <= 768) return false;
    if (!mediaList?.length) return false;
    // Only autoplay when this is the sole video in the attachment list
    const videoItems = mediaList.filter(item => isVideoMedia(item));
    if (videoItems.length !== 1) return false;
    return videoItems[0].mid === media.mid;
}

const displayedTweet = computed(() => {
    return isRetweet.value && originTweet.value ? originTweet.value : tweet.value;
});

// Filter audio attachments into a compact playlist above visual media
const audioAttachments = computed(() => {
    const attachments = displayedTweet.value?.attachments || [];
    return attachments.filter((attachment: MimeiFileType) => {
        const normalizedType = normalizeMediaType(attachment.type);
        return normalizedType.includes('audio');
    });
});

// Filter media attachments (image, video only) for the displayed tweet

const mediaAttachments = computed(() => {
    const attachments = displayedTweet.value?.attachments || [];
    return attachments.filter((attachment: MimeiFileType) => {
        const normalizedType = normalizeMediaType(attachment.type);
        return normalizedType.includes('image') ||
               normalizedType.includes('video');
    });
});

// When the only attachment is a landscape video, shape the container to
// match its aspect ratio instead of the default tall (≥80vh) box used
// for portrait videos. Returns the ratio (width/height) or null.
const landscapeVideoRatio = computed<number | null>(() => {
    const items = mediaAttachments.value;
    if (items.length !== 1) return null;
    const item = items[0];
    if (!isVideoMedia(item)) return null;
    const ar = (item as any).aspectRatio;
    return typeof ar === 'number' && ar > 1 ? ar : null;
});

// True only when the sole attachment is a video — height is capped to fit
// the viewport in that case. Images and multi-attachment layouts render normally.
const isSingleVideo = computed<boolean>(() => {
    const items = mediaAttachments.value;
    return items.length === 1 && isVideoMedia(items[0]);
});

// Filter out media attachments (image, video, audio) to get documents
const documentAttachments = computed(() => {
    const attachments = displayedTweet.value?.attachments || [];
    return attachments.filter((attachment: MimeiFileType) => {
        const normalizedType = normalizeMediaType(attachment.type);
        return !normalizedType.includes('image') && 
               !normalizedType.includes('video') && 
               !normalizedType.includes('audio');
    });
});

// Format file size in human-readable form
function formatFileSize(bytes: number | undefined): string {
    if (!bytes || bytes === 0) return '0 ' + t('size.bytes');
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Check if a file type can be viewed directly in the browser
function isBrowserViewable(doc: MimeiFileType): boolean {
    const normalizedType = normalizeMediaType(doc.type);
    const fileName = doc.fileName?.toLowerCase() || '';
    
    // Check MIME types that browsers can display
    const viewableMimeTypes = [
        'application/pdf',
        'text/html',
        'application/xhtml+xml',
        'text/plain',
        'text/css',
        'text/javascript',
        'text/json',
        'text/xml',
        'application/xml',
        'application/json',
        'text/markdown',
        'text/x-markdown',
        'text/csv',
        'application/javascript',
        'application/x-javascript'
    ];
    
    // Check if MIME type is viewable
    for (const viewableType of viewableMimeTypes) {
        if (normalizedType.includes(viewableType)) {
            return true;
        }
    }
    
    // Also check file extensions as fallback
    const viewableExtensions = ['.pdf', '.html', '.htm', '.txt', '.css', '.js', '.json', '.xml', '.md', '.markdown', '.csv'];
    for (const ext of viewableExtensions) {
        if (fileName.endsWith(ext)) {
            return true;
        }
    }
    
    return false;
}

// Handle document click - open browser-viewable files directly, download others with filename
async function handleDocumentClick(event: MouseEvent, doc: MimeiFileType) {
    // Prevent any parent click handlers
    event.stopPropagation();
    
    // Get the document URL
    let docUrl: string;
    
    // If mid is already a full URL, use it directly
    if (doc.mid.startsWith('http://') || doc.mid.startsWith('https://')) {
        docUrl = doc.mid;
    } else {
        // Extract hash from mid if it contains a path separator
        const lastIndexOf = doc.mid.lastIndexOf("/");
        const hash = lastIndexOf > 0 ? doc.mid.substring(lastIndexOf + 1) : doc.mid;
        
        // Get provider IP from the tweet
        const currentTweet = displayedTweet.value;
        const providerIp = currentTweet?.provider || currentTweet?.author?.providerIp;
        const baseUrl = providerIp ? `http://${providerIp}` : window.location.origin;
        
        // Construct the full URL using tweetStore.getMediaUrl
        docUrl = tweetStore.getMediaUrl(hash, baseUrl);
    }
    
    // Check if the document can be viewed directly in the browser
    if (isBrowserViewable(doc)) {
        // Open browser-viewable files directly in a new tab
        window.open(docUrl, '_blank');
        return;
    }
    
    // For files that browsers cannot display, download with filename
    const filename = doc.fileName || 'document';
    
    try {
        // Fetch the file as a blob
        const response = await fetch(docUrl);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        
        const blob = await response.blob();
        
        // Create a blob URL
        const blobUrl = window.URL.createObjectURL(blob);
        
        // Create download link with the filename
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up the blob URL after a short delay
        setTimeout(() => {
            window.URL.revokeObjectURL(blobUrl);
        }, 100);
    } catch (error) {
        console.error('Download failed:', error);
        // Fallback: open in new tab if download fails
        window.open(docUrl, '_blank');
    }
}

// Comment pagination and sync state — mirrors iOS TweetDetailView's CommentListView
const commentPage = ref(0)
const isLoadingMoreComments = ref(false)
const hasMoreComments = ref(true)
const commentBottomSentinel = ref<HTMLElement | null>(null)
let commentObserver: IntersectionObserver | null = null
let detailResyncInFlight = false
let lastDetailResyncAt = 0
const DETAIL_RESYNC_MIN_INTERVAL_MS = 60 * 1000

// Independent periodic comment refresh: first check 15s after the initial
// load, then every 5 minutes, so new comments show up without a full reload.
let commentRefreshTimer: ReturnType<typeof setTimeout> | null = null
const COMMENT_REFRESH_INITIAL_DELAY_MS = 15 * 1000
const COMMENT_REFRESH_INTERVAL_MS = 5 * 60 * 1000

// loadComments mutates owner.comments in place; triggerRef is required to
// notify Vue since nothing else re-reads tweet/originTweet after this fires.
async function refreshCommentsAndNotify(owner: Tweet) {
    await tweetStore.loadComments(owner)
    triggerRef(tweet)
    triggerRef(originTweet)
}

function startCommentRefreshLoop(owner: Tweet) {
    stopCommentRefreshLoop()
    commentRefreshTimer = setTimeout(() => {
        console.log('[commentRefreshLoop] Initial refresh triggered for', owner.mid)
        void refreshCommentsAndNotify(owner)
        commentRefreshTimer = setInterval(() => {
            console.log('[commentRefreshLoop] Periodic refresh triggered for', owner.mid)
            void refreshCommentsAndNotify(owner)
        }, COMMENT_REFRESH_INTERVAL_MS)
    }, COMMENT_REFRESH_INITIAL_DELAY_MS)
}

function stopCommentRefreshLoop() {
    if (commentRefreshTimer) {
        clearTimeout(commentRefreshTimer)
        clearInterval(commentRefreshTimer)
        commentRefreshTimer = null
    }
}

function setupCommentObserver() {
    if (commentObserver) {
        commentObserver.disconnect()
        commentObserver = null
    }
    nextTick(() => {
        if (!commentBottomSentinel.value) return
        commentObserver = new IntersectionObserver(async (entries) => {
            if (entries[0].isIntersecting) {
                await loadMoreComments()
            }
        }, { threshold: 0.1 })
        commentObserver.observe(commentBottomSentinel.value)
    })
}

async function loadMoreComments() {
    if (isLoadingMoreComments.value || !hasMoreComments.value) return
    const targetTweet = isRetweet.value ? originTweet.value : tweet.value
    if (!targetTweet) return
    isLoadingMoreComments.value = true
    const nextPage = commentPage.value + 1
    try {
        const hasMore = await tweetStore.loadMoreComments(targetTweet, nextPage)
        hasMoreComments.value = hasMore
        commentPage.value = nextPage
    } finally {
        isLoadingMoreComments.value = false
    }
}

function applyRefreshedTweet(target: Tweet, refreshed: Tweet) {
    // Keep existing comments (including optimistic/local synced entries) and
    // update detail fields from refresh_tweet.
    const existingComments = target.comments ?? []
    tweetStore.refreshCachedTweet(target, refreshed)
    target.title = refreshed.title
    target.content = refreshed.content
    target.attachments = refreshed.attachments
    target.author = refreshed.author
    target.provider = refreshed.provider
    target.originalTweetId = refreshed.originalTweetId
    target.originalAuthorId = refreshed.originalAuthorId
    target.originalTweet = refreshed.originalTweet
    target.comments = existingComments
}

async function refreshDetailTarget(target: Tweet | undefined, targetTweetId: MimeiId, targetAuthorId: MimeiId) {
    const targetAuthor = target?.author ?? await tweetStore.getUser(targetAuthorId)
    if (!shouldResyncUser(targetAuthor)) {
        console.log(`[TweetDetail] Skipping refresh_tweet for ${targetTweetId}: read/root nodes do not differ`)
        return null
    }

    console.log(`[TweetDetail] Calling refresh_tweet for ${targetTweetId}`)
    const refreshed = await tweetStore.getTweet(targetTweetId, targetAuthorId, false, true, true)
    console.log(`[TweetDetail] Completed refresh_tweet for ${targetTweetId}`)
    return refreshed
}

// Refreshes only detail tweet(s) whose author read node differs from root.
// Runs in the background after cached/initial content is already shown.
async function resyncDetailTweets() {
    if (detailResyncInFlight) return
    const now = Date.now()
    if (now - lastDetailResyncAt < DETAIL_RESYNC_MIN_INTERVAL_MS) return
    detailResyncInFlight = true
    lastDetailResyncAt = now
    const recoveryTweetId = tweet.value?.mid
    try {
    if (!tweet.value) return
    const isPureRetweet = !!tweet.value.originalTweetId && !tweet.value.content && !tweet.value.attachments?.length
    if (tweet.value.originalTweetId && tweet.value.originalAuthorId) {
        if (isPureRetweet) {
            const refreshedOriginal = await refreshDetailTarget(
                originTweet.value,
                tweet.value.originalTweetId as MimeiId,
                tweet.value.originalAuthorId as MimeiId
            )
            if (tweet.value?.mid !== recoveryTweetId) return
            if (refreshedOriginal && originTweet.value) {
                applyRefreshedTweet(originTweet.value, refreshedOriginal)
                triggerRef(originTweet)
            }
            return
        }

        const [refreshedTweet, refreshedOriginal] = await Promise.all([
            refreshDetailTarget(tweet.value, tweet.value.mid as MimeiId, tweet.value.authorId as MimeiId),
            refreshDetailTarget(
                originTweet.value,
                tweet.value.originalTweetId as MimeiId,
                tweet.value.originalAuthorId as MimeiId
            ),
        ])
        if (tweet.value?.mid !== recoveryTweetId) return
        if (refreshedTweet && tweet.value) {
            applyRefreshedTweet(tweet.value, refreshedTweet)
            triggerRef(tweet)
        }
        if (refreshedOriginal && originTweet.value) {
            applyRefreshedTweet(originTweet.value, refreshedOriginal)
            triggerRef(originTweet)
        }
        return
    }

    const refreshed = await refreshDetailTarget(tweet.value, tweet.value.mid as MimeiId, tweet.value.authorId as MimeiId)
    if (tweet.value?.mid !== recoveryTweetId) return
    if (refreshed && tweet.value) {
        applyRefreshedTweet(tweet.value, refreshed)
        triggerRef(tweet)
    }
    } finally {
        detailResyncInFlight = false
    }
}

onUnmounted(() => {
    if (viewportInsetRefreshTimer) {
        clearTimeout(viewportInsetRefreshTimer)
        viewportInsetRefreshTimer = null
    }
    window.visualViewport?.removeEventListener('resize', updateDownloadButtonViewportInset)
    window.visualViewport?.removeEventListener('scroll', updateDownloadButtonViewportInset)
    window.removeEventListener('resize', updateDownloadButtonViewportInset)
    document.documentElement.style.removeProperty('--tweet-detail-browser-bottom-inset')

    if (commentObserver) {
        commentObserver.disconnect()
        commentObserver = null
    }
    stopCommentRefreshLoop()
})

// Store navigation metadata in sessionStorage to persist across route changes
const navigationMeta = ref<{
    fromComment: boolean;
    parentTweetId: string | undefined;
    parentAuthorId: string | undefined;
} | null>(null);

const updateNavigationMeta = () => {
    try {
        // First check if we have navigation metadata in the URL query params
        const fromQuery = {
            fromComment: route.query.fromComment === 'true',
            parentTweetId: route.query.parentTweetId as string | undefined,
            parentAuthorId: route.query.parentAuthorId as string | undefined
        };

        // If we have valid navigation metadata from query params, store it in sessionStorage
        if (fromQuery.fromComment && fromQuery.parentTweetId) {
            sessionStorage.setItem('navigationMeta', JSON.stringify(fromQuery));
            navigationMeta.value = fromQuery;
            return;
        }

        // Otherwise, check sessionStorage for previously stored metadata
        const stored = sessionStorage.getItem('navigationMeta');
        if (stored) {
            navigationMeta.value = JSON.parse(stored);
            return;
        }

        navigationMeta.value = null;
    } catch (error) {
        console.warn('[updateNavigationMeta] Error parsing navigation meta:', error);
        navigationMeta.value = null;
    }
};

// Initialize navigation metadata
updateNavigationMeta();

// Watch for route changes and update navigation metadata
watch(() => route.query, () => {
    updateNavigationMeta();
}, { immediate: true });

// Clear invalid navigation metadata (when parentTweetId equals current tweetId)
watch(tweetId, () => {
    if (navigationMeta.value && navigationMeta.value.parentTweetId === tweetId.value) {
        console.log('[TweetDetail] Clearing invalid navigation metadata (points to self)');
        sessionStorage.removeItem('navigationMeta');
        navigationMeta.value = null;
    }
});

const isFromComment = computed(() => !!navigationMeta.value?.fromComment);
const parentTweetId = computed(() => navigationMeta.value?.parentTweetId);
const parentAuthorId = computed(() => navigationMeta.value?.parentAuthorId);

function goBack() {
    if (parentTweetId.value && parentAuthorId.value) {
        router.push(`/tweet/${parentTweetId.value}/${parentAuthorId.value}`);
    } else {
        router.back();
    }
}

async function leaveDeletedTweet() {
    if (parentTweetId.value && parentAuthorId.value) {
        await router.replace(`/tweet/${parentTweetId.value}/${parentAuthorId.value}`);
        return;
    }

    // A history pop can be a no-op for a reloaded/deep-linked detail route.
    // Replace the deleted route with Vue Router's recorded origin so Back
    // cannot reopen a tweet that no longer exists.
    const recordedBackPath = window.history.state?.back;
    const destination = typeof recordedBackPath === 'string' && recordedBackPath !== route.fullPath
        ? recordedBackPath
        : router.resolve({ name: 'main' }).fullPath;
    await router.replace(destination);
}

function retryLoad() {
    console.log('[TweetDetail] User initiated retry');
    tweetNotFound.value = false;
    // Start from scratch rather than replaying the lookup that just failed —
    // otherwise the retry resolves the same cached verdict and fails at once.
    tweetStore.clearRouteFailures([tweetId.value, authorId.value]);
    loadDetail({ forceRouteRefresh: true });
}
</script>

<template>
<PageLayout>
    <div v-if="isFromComment" class="back-button mb-2" @click="goBack">
        ← {{ $t('common.back') }}
    </div>
    
    <!-- Tweet not found - resolution came back empty after all retries. This can
         mean the tweet was deleted, but can equally mean the multi-provider
         lookup itself failed transiently, so offer both Retry and Go Back. -->
    <div v-if="tweetNotFound && !isLoading && hasLoadAttempted && !tweet" class="loading-retry-message text-center my-4">
        <div class="alert alert-warning" role="alert">
            <h5 class="alert-heading">{{ $t('tweet.tweetNotFound') }}</h5>
            <p class="mb-3">{{ $t('tweet.tweetNotFoundDesc') }}</p>
            <button @click="retryLoad" class="btn btn-primary me-2">
                <span v-if="isLoading" class="spinner-border spinner-border-sm me-2" role="status"></span>
                {{ $t('common.retry') }}
            </button>
            <button @click="goBack" class="btn btn-secondary">
                {{ $t('tweet.goBack') }}
            </button>
        </div>
    </div>

    <!-- General error message with retry button - for network/other errors -->
    <div v-if="loadError && !isLoading && hasLoadAttempted && !tweet && !tweetNotFound" class="loading-retry-message text-center my-4">
        <div class="alert alert-danger" role="alert">
            <h5 class="alert-heading">{{ $t('tweet.unableToLoad') }}</h5>
            <p class="mb-2">{{ $t('tweet.loadError') }}</p>
            <p class="mb-3 text-muted small">{{ $t('tweet.checkConsole') }}</p>
            <button @click="retryLoad" class="btn btn-primary">
                <span v-if="isLoading" class="spinner-border spinner-border-sm me-2" role="status"></span>
                {{ $t('common.retry') }}
            </button>
        </div>
    </div>

    <div v-if="tweet" class="card mb-1">
        <div class="card-header d-flex align-items-stretch">
            <DetailHeader class="w-100" v-if="isRetweet && tweet.originalTweet?.author && tweet.author" :author="tweet.originalTweet.author" :timestamp="tweet.timestamp"
                :is-retweet="isRetweet" :by="tweet.author.username"
                :exclude-tweet-id="tweet.originalTweet?.mid"
                :tweet="tweet" :edit-tweet="tweet.originalTweet" :after-delete="leaveDeletedTweet">
            </DetailHeader>
            <DetailHeader class="w-100" v-else-if="!isRetweet && tweet.author" :author="tweet.author" :timestamp="tweet.timestamp"
                :exclude-tweet-id="tweet.mid"
                :tweet="tweet" :after-delete="leaveDeletedTweet">
            </DetailHeader>
        </div>
        
        <div v-if="isRetweet" class="card-body" id="content">

            <p
                v-if="originTweet.content"
                class="card-text"
                v-html="linkify(originTweet.content)"
            ></p>

            <AudioPlaylistPlayer
                v-if="audioAttachments.length > 0"
                class="detail-audio-player"
                :media-list="audioAttachments"
            />
            <div v-if="mediaAttachments.length > 0"
                :class="['media-attachments', {
                    'media-attachments--multi': mediaAttachments.length > 1,
                    'media-attachments--landscape': landscapeVideoRatio,
                    'media-attachments--video-only': isSingleVideo,
                }]"
                :style="landscapeVideoRatio ? { aspectRatio: String(landscapeVideoRatio) } : undefined">
                <!-- Keep stateful media components attached to a media ID, not an array position. -->
                <MediaView v-for="(media, index) in mediaAttachments" :key="media.mid" :media=media
                    v-bind:tweet="tweet" :autoplay="shouldAutoplay(media, mediaAttachments)" :media-list="mediaAttachments" :media-index="Number(index)" class="img-fluid"></MediaView>
            </div>
            <div v-if='documentAttachments.length > 0' class='document-attachments'>
                <div
                    v-for='doc in documentAttachments'
                    :key='doc.mid'
                    class='document-row'
                    @click='handleDocumentClick($event, doc)'
                >
                    <span class='document-icon'>📄</span>
                    <span class='document-filename'>{{ doc.fileName || $t('tweet.unknownFile') }}</span>
                    <span class='document-size'>{{ formatFileSize(doc.size) }}</span>
                </div>
            </div>
            <TweetActionBar :tweet="originTweet" @updated="(t) => originTweet = t" />
        </div>
        <div v-else class="card-body">
            <p
                v-if="tweet.content"
                class="card-text"
                v-html="linkify(tweet.content)"
            ></p>

            <AudioPlaylistPlayer
                v-if="audioAttachments.length > 0"
                class="detail-audio-player"
                :media-list="audioAttachments"
            />
            <div v-if="mediaAttachments.length > 0"
                :class="['media-attachments', {
                    'media-attachments--multi': mediaAttachments.length > 1,
                    'media-attachments--landscape': landscapeVideoRatio,
                    'media-attachments--video-only': isSingleVideo,
                }]"
                :style="landscapeVideoRatio ? { aspectRatio: String(landscapeVideoRatio) } : undefined">
                <MediaView v-for="(media, index) in mediaAttachments" :key="media.mid" :media=media
                    v-bind:tweet="tweet" :autoplay="shouldAutoplay(media, mediaAttachments)" :media-list="mediaAttachments" :media-index="Number(index)" class="img-fluid">
                </MediaView>
            </div>
            <div v-if='documentAttachments.length > 0' class='document-attachments'>
                <div 
                    v-for='doc in documentAttachments'
                    :key='doc.mid'
                    class='document-row'
                    @click='handleDocumentClick($event, doc)'
                >
                    <span class='document-icon'>📄</span>
                    <span class='document-filename'>{{ doc.fileName || $t('tweet.unknownFile') }}</span>
                    <span class='document-size'>{{ formatFileSize(doc.size) }}</span>
                </div>
            </div>

            <!-- quoted tweet -->
            <blockquote v-if="!isRetweet && tweet.originalTweetId" class="quoted-tweet">
                <TweetView
                    v-if="originTweet"
                    :tweet="originTweet"
                    :is-quoted="true"
                    :max-content-lines="TWEET_LIST_CONTENT_MAX_LINES"
                />
                <p v-else class="quoted-tweet-placeholder">{{ t('tweet.loadingQuotedTweet') }}</p>
            </blockquote>

            <TweetActionBar :tweet="tweet" @updated="(t) => tweet = t" />
        </div>
    </div>

    <!-- Comment list — reuses the same TweetList component as the main feed -->
    <div v-if="tweet" :class="['comment-list', 'mt-3', { 'has-comments': isRetweet ? originTweet?.comments?.length : tweet.comments?.length }]">
        <TweetList
            v-if="isRetweet && originTweet?.comments?.length"
            :tweets="originTweet.comments"
            :is-comment="true"
            :parent-tweet="originTweet"
        />
        <TweetList
            v-else-if="!isRetweet && tweet.comments?.length"
            :tweets="tweet.comments"
            :is-comment="true"
            :parent-tweet="tweet"
        />
        <!-- Infinite scroll sentinel — becoming visible triggers next page load -->
        <div ref="commentBottomSentinel" class="comment-sentinel"></div>
        <div v-if="isLoadingMoreComments" class="d-flex justify-content-center my-2">
            <LoadingSpinner />
        </div>
        <div v-if="!hasMoreComments && (isRetweet ? originTweet?.comments?.length : tweet.comments?.length)"
             class="text-center text-muted small py-3">
            {{ $t('tweet.noMoreComments') }}
        </div>
    </div>

    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <LoadingSpinner />
    </div>

    <!-- Open in App Button -->
    <div
        v-if="showDownloadPrompt"
        ref="btnEl"
        class="download-button-container"
        :class="{ dragging: isDragging }"
        :style="btnInitialized ? { left: btnPos.x + 'px', top: btnPos.y + 'px' } : {}"
        @mousedown="onDragStart"
        @touchstart="onDragStart"
    >
        <button class="download-button">
            <img src="/src/ic_splash.png" alt="App Icon" class="download-icon" />
            <span class="download-text">{{ $t('download.openInApp') }}</span>
        </button>
    </div>
</PageLayout>
</template>

<style scoped>
.quoted-tweet {
    margin: 8px 0 8px 32px;
    border: 1px solid #e6ecf0;
    border-radius: 8px;
    overflow: hidden;
    background-color: #d0d8e4;
}
.quoted-tweet :deep(.tweet-container) {
    background-color: #d0d8e4;
}
.quoted-tweet-placeholder {
    margin: 0;
    padding: 12px;
    color: #657786;
    font-size: 14px;
}

.comment-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.comment-sentinel {
    height: 1px;
}
.comment-list.has-comments {
    margin-bottom: 1rem;
}

.comment-list > .card {
    margin-bottom: 0;
}

/* Loading retry message styling */
.loading-retry-message {
    padding: 2rem 1rem;
    color: #495057;
    background-color: transparent;
}

/* Remove card styling on mobile for flush layout */
@media (max-width: 575px) {
  .card {
    margin: 0 !important;
    border: none !important;
    border-radius: 0 !important;
  }

  .card-body {
    padding: 0 !important;
  }

  .card-header {
    padding: 0 !important;
    padding-left: 8px !important; /* Add left padding for item header breathing room */
  }
}

.loading-retry-message p {
    font-size: 1rem;
    color: #6c757d;
}

.card {
    width: 100%;
    margin: 0px 0px 30px 0px;
}

.card-header {
    margin: 0px;
    padding: 0px 8px;
}

.card-body {
    margin: 0px;
    padding: 4px 0px;
}

.card-text {
    text-align: left;
    font-size: medium;
    white-space: pre-wrap;
    padding: 0px 8px;
}
.card-text a {
    color: blue;
    text-decoration: underline;
}

@media (max-width: 767px) {
    .btn {
        font-size: 12px;
        /* Adjust the font size as needed */
        padding: 6px 10px;
        /* Adjust the padding as needed */
    }
}

.media-attachments {
    width: calc(100% + 5px);
    max-width: calc(100% + 5px);
    margin-left: -5px;
    margin-right: 0;
    margin-top: 0;
    margin-bottom: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

/* Only constrain height when the sole attachment is a video */
.media-attachments--video-only {
    max-height: 80vh;
    overflow: hidden;
}

.detail-audio-player {
    margin: 8px 8px 8px 3px;
    width: calc(100% - 11px);
}

.media-attachments :deep(.container) {
    width: 100% !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
    margin: 0 !important;
    padding: 0 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}

/* img-wrapper uses height:100% which resolves to 0 when parent has height:auto in flex;
   force auto so the image's natural size drives layout */
.media-attachments :deep(.img-wrapper) {
    height: auto !important;
    max-height: none !important;
}

.media-attachments--video-only :deep(.container) {
    height: 100% !important;
    max-height: 80vh !important;
    overflow: hidden !important;
}

.media-attachments :deep(img) {
    max-width: 100% !important;
    max-height: none !important;
    width: auto !important;
    height: auto !important;
    display: block;
    margin: 0 auto !important;
    padding: 0 !important;
    object-fit: contain;
}

.media-attachments :deep(.video-container),
.media-attachments :deep(.video-wrapper) {
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    margin: 0 !important;
    padding: 0 !important;
}

.media-attachments :deep(video) {
    max-width: 100% !important;
    width: auto !important;
    height: auto !important;
    display: block;
    margin: 0 auto !important;
    padding: 0 !important;
    object-fit: contain;
}

.media-attachments--video-only :deep(.video-container),
.media-attachments--video-only :deep(.video-wrapper) {
    max-height: 80vh !important;
}

.media-attachments--video-only :deep(video) {
    max-height: 80vh !important;
}

/* Single landscape video: shape the container to the video's aspect ratio
   instead of the default tall (≥80vh) box. The aspect-ratio is set inline. */
.media-attachments--landscape {
    max-height: none;
    width: 100%;
}

.media-attachments--landscape :deep(.container),
.media-attachments--landscape :deep(.video-container),
.media-attachments--landscape :deep(.video-wrapper) {
    width: 100% !important;
    height: 100% !important;
    max-height: none !important;
    min-height: 0 !important;
}

.media-attachments--landscape :deep(video) {
    width: 100% !important;
    height: 100% !important;
    max-height: none !important;
    min-height: 0 !important;
    object-fit: contain;
}

/* Multiple media: vertical list layout */
.media-attachments--multi {
    flex-direction: column;
    align-items: stretch;
    max-height: none;
    overflow: visible;
    gap: 1px;
    width: 100%;
    max-width: 100%;
    margin-left: 0;
    box-sizing: border-box;
    border: 1px solid gray;
    background-color: gray;
}

.media-attachments--multi :deep(.container),
.media-attachments--multi :deep(img),
.media-attachments--multi :deep(video) {
    width: 100% !important;
    max-height: none !important;
    content-visibility: auto;
}

/* Desktop: portrait-only single video fills at least 80vh.
   Landscape videos use their natural aspect ratio (set inline). */
@media (min-width: 768px) {
    .media-attachments--video-only:not(.media-attachments--landscape) {
        min-height: 80vh;
    }

    .media-attachments--video-only:not(.media-attachments--landscape) :deep(.video-container),
    .media-attachments--video-only:not(.media-attachments--landscape) :deep(.video-wrapper) {
        min-height: 80vh !important;
    }

    .media-attachments--video-only:not(.media-attachments--landscape) :deep(video) {
        min-height: 80vh !important;
    }
}

.rounded-circle {
    width: 40px;
    height: 40px;
}

/* App Download Prompt Styles */

/* Modal Styles */
.modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 2000;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 20px;
}

.modal-content {
    background: white;
    border-radius: 12px;
    max-width: 400px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
}

.modal-body {
    padding: 24px;
    padding-top: 24px;
}

.platform-options {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.platform-option {
    display: flex;
    align-items: center;
    padding: 20px;
    border: 2px solid #f0f0f0;
    border-radius: 12px;
    transition: all 0.2s ease;
    background: #fafafa;
    gap: 20px;
    min-height: 60px;
}

.platform-option:last-child {
    padding-left: 20px;
    position: relative;
}

.platform-option:hover {
    border-color: #667eea;
    background: #f8f9ff;
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(102, 126, 234, 0.15);
}

.platform-icon {
    font-size: 2rem;
    margin-right: 0;
    text-align: center;
    flex-shrink: 0;
}

.platform-info {
    flex: 1;
    margin-right: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
}

.platform-info h5 {
    margin: 0 0 4px 0;
    color: #333;
    font-size: 1.1rem;
    font-weight: 600;
}

.platform-info p {
    margin: 0;
    color: #666;
    font-size: 0.9rem;
}

.platform-qr {
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: pointer;
}

.download-spinner {
    position: absolute;
    top: 50%;
    right: 20px;
    transform: translateY(-50%);
    color: #667eea;
}

.browser-link {
    color: #667eea;
    text-decoration: none;
    cursor: pointer;
    transition: color 0.2s ease;
}

.browser-link:hover {
    color: #5a6fd8;
    text-decoration: underline;
}

@keyframes slideDown {
    from {
        transform: translateY(-100%);
        opacity: 0;
    }
    to {
        transform: translateY(0);
        opacity: 1;
    }
}


.back-button {
    padding: 8px 16px;
    cursor: pointer;
    display: inline-block;
    font-weight: 500;
    color: #ccd0d4;
}

.back-button:hover {
    color: #ccd0d4;
    text-decoration: underline;
    opacity: 1;
}

.document-attachments {
    margin-top: 12px;
    padding: 8px;
    border-top: 1px solid #e0e0e0;
}

.document-row {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    margin-bottom: 2px;
    background-color: #f8f9fa;
    border-radius: 4px;
    transition: background-color 0.2s;
    cursor: pointer;
}

.document-row:hover {
    background-color: #e9ecef;
}

.document-row:last-child {
    margin-bottom: 0;
}

.document-icon {
    font-size: 20px;
    margin-right: 12px;
    flex-shrink: 0;
}

.document-filename {
    flex: 1;
    min-width: 0;
    font-weight: 500;
    color: #333;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.document-size {
    margin-left: 12px;
    color: #6c757d;
    font-size: 0.9em;
    white-space: nowrap;
    flex-shrink: 0;
}

/* Download Button Styles */
.download-button-container {
    position: fixed;
    bottom: calc(max(var(--tweet-detail-browser-bottom-inset, 0px), env(safe-area-inset, 0px)) + 8px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    width: fit-content;
    cursor: grab;
    user-select: none;
    touch-action: none;
    /* Once inline left/top are set, override bottom and transform */
}

.download-button-container[style] {
    bottom: unset;
    transform: none;
}

.download-button-container.dragging {
    cursor: grabbing;
}

.download-button {
    --download-button-height: 44px;
    position: relative;
    height: var(--download-button-height);
    background: #5a67d8;
    color: #ffffff;
    border: none;
    border-radius: 999px;
    padding: 0 52px;
    font-size: 1rem;
    font-weight: 500;
    cursor: inherit;
    box-shadow: 0 4px 12px rgba(90, 103, 216, 0.4);
    transition: background 0.2s ease, box-shadow 0.2s ease;
    white-space: nowrap;
    display: flex;
    align-items: center;
    justify-content: center;
}

.download-icon {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: var(--download-button-height);
    height: var(--download-button-height);
    display: block;
    object-fit: cover;
    border-radius: 50%;
}

.download-text {
    font-size: 1rem;
    font-weight: 500;
}

.download-button:hover {
    background: #4c5bc7;
    box-shadow: 0 6px 16px rgba(90, 103, 216, 0.5);
}

.download-button:active {
    box-shadow: 0 2px 8px rgba(90, 103, 216, 0.4);
}

@media (max-width: 768px) {
    .download-button {
        --download-button-height: 36px;
        font-size: 0.9rem;
        padding: 0 44px;
    }

    .download-text {
        font-size: 0.9rem;
    }

}

</style>
