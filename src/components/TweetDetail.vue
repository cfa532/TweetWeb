<script lang="ts" setup>
import { ref, onMounted, watch, computed, nextTick, triggerRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from "@/stores";
import { MediaView, DetailHeader, TweetView, TweetActionBar } from "@/views";
import { DownloadModal, LoadingSpinner, PageLayout, TweetList } from "@/components";
import { normalizeMediaType, isWeChatBrowser } from '@/lib';
import { LOAD_TIMEOUT_MS, MAX_REFRESH_ATTEMPTS, RETRY_DELAY_MS } from '@/constants';

const { t } = useI18n();

const route = useRoute();
const router = useRouter();
const tweetStore = useTweetStore()
const tweetId = computed(()=>route.params.tweetId as MimeiId)
const authorId = computed(()=>route.params.authorId as MimeiId | undefined)
const tweet = ref()
const originTweet = ref()
const isRetweet = ref(false)
const isLoading = ref(false)
const loadError = ref(false)
const tweetNotFound = ref(false)
const hasLoadAttempted = ref(false)

// Download prompt variables
const showDownloadPrompt = ref(false)
const showDownloadModal = ref(false)
const isDownloading = ref(false)

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
        openDownloadModal()
    }
}


onMounted(async () => {
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

    // Show download button after 2 seconds
    setTimeout(() => {
        showDownloadPrompt.value = true
    }, 2000)
});
async function loadDetail(retryCount = 0) {
    const maxRetries = MAX_REFRESH_ATTEMPTS
    isLoading.value = true
    loadError.value = false
    tweetNotFound.value = false
    hasLoadAttempted.value = true

    // Safety timeout: refresh page after timeout if still loading (max attempts)
    const refreshCount = parseInt(sessionStorage.getItem('tweetDetailRefreshCount') || '0');
    let timeoutId: number | null = null;

    if (refreshCount < MAX_REFRESH_ATTEMPTS) {
        timeoutId = window.setTimeout(() => {
            console.warn(`[TweetDetail] Loading timeout after ${LOAD_TIMEOUT_MS}ms - refreshing page (${refreshCount + 1}/${MAX_REFRESH_ATTEMPTS})`);
            sessionStorage.setItem('tweetDetailRefreshCount', (refreshCount + 1).toString());
            isLoading.value = false;
            window.location.reload();
        }, LOAD_TIMEOUT_MS);
    } else {
        console.warn(`[TweetDetail] Max refresh attempts (${MAX_REFRESH_ATTEMPTS}) reached, stopping`);
        isLoading.value = false;
        sessionStorage.removeItem('tweetDetailRefreshCount');
        loadError.value = true;
        return; // Exit early if max retries reached
    }

    try {
        // Always fetch fresh data from server
        console.log('[TweetDetail TIMING] Calling getTweet...', new Date().toISOString())
        tweet.value = await tweetStore.getTweet(tweetId.value, authorId.value, true) as Tweet
        console.log('[TweetDetail TIMING] ✅ Tweet received and set, Vue will render now:', new Date().toISOString())

        if (!tweet.value) {
            throw new Error('Tweet not found (null response)')
        }

        loadError.value = false
        await showTweet(timeoutId)
        console.log(tweet.value)

        // display url as link
        document.addEventListener("DOMContentLoaded", function () {
            const contentElement = document.getElementById('content');
            const paragraphs = contentElement?.getElementsByClassName('card-text');
            if (paragraphs)
                for (let i = 0; i < paragraphs.length; i++) {
                    const paragraph = paragraphs[i];
                    paragraph.innerHTML = linkify(paragraph.innerHTML);
                }
        });
    } catch (error) {
        console.error(`Error loading tweet detail (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);

        // Log essential error details for debugging stuck loading states
        if (error && typeof error === 'object' && 'message' in error) {
            console.error(`Error details: ${error.message}`);
        }

        // Check if this is a "tweet not found" error
        const isTweetNotFound = error && typeof error === 'object' && 'message' in error &&
                               error.message === 'Tweet not found (null response)';

        if (isTweetNotFound) {
            console.error('[TweetDetail] Tweet not found - showing specific error message')
            isLoading.value = false
            tweetNotFound.value = true
        } else if (retryCount < maxRetries) {
            console.log(`[TweetDetail] Retrying by refreshing page... (${retryCount + 1}/${maxRetries})`)
            // Add delay before retry
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));

            // Refresh immediately on error (within max retries limit)
            const refreshCount = parseInt(sessionStorage.getItem('tweetDetailRefreshCount') || '0');
            if (refreshCount < MAX_REFRESH_ATTEMPTS) {
                sessionStorage.setItem('tweetDetailRefreshCount', (refreshCount + 1).toString());
                clearTimeout(timeoutId);
                window.location.reload();
            } else {
                console.warn(`[TweetDetail] Max refresh attempts (${MAX_REFRESH_ATTEMPTS}) reached in retry logic, giving up`);
                clearTimeout(timeoutId);
                isLoading.value = false;
                loadError.value = true;
                sessionStorage.removeItem('tweetDetailRefreshCount');
            }
        } else {
            console.error('[TweetDetail] Max retries reached, giving up')
            clearTimeout(timeoutId)
            isLoading.value = false
            loadError.value = true
        }
    }
}
async function showTweet(timeoutId?: number) {
    try {
        // Tweet content is ready to display - set loading to false early
        document.title = formattedTitle.value
        if (timeoutId) clearTimeout(timeoutId)
        isLoading.value = false
        sessionStorage.removeItem('tweetDetailRefreshCount') // Clear refresh count on success

        // Load comments and additional data in parallel (truly non-blocking)
        const loadPromises = []

        // Load original tweet if needed
        if (tweet.value.originalTweetId) {
            loadPromises.push((async () => {
                try {
                    originTweet.value = await tweetStore.getTweet(tweet.value.originalTweetId, tweet.value.originalAuthorId!)
                    if (!tweet.value.content && !tweet.value.attachments) {
                        isRetweet.value = true
                        await tweetStore.loadComments(originTweet.value)
                    }
                } catch (error) {
                    console.warn('[TweetDetail] Failed to load original tweet:', error)
                }
            })())
        } else {
            loadPromises.push(tweetStore.loadComments(tweet.value).catch(error => {
                console.warn('[TweetDetail] Failed to load comments:', error)
            }))
        }

        // Await comments loading, then trigger Vue reactivity
        await Promise.allSettled(loadPromises)
        // Use triggerRef to notify Vue that the ref's inner value has changed
        triggerRef(tweet)
        triggerRef(originTweet)
    } catch (error) {
        console.error('Error in showTweet:', error)
        if (timeoutId) clearTimeout(timeoutId)
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
        if (tweet.value.originalTweetId) {
            if (!tweetStore.isEmptyString(tweet.value.originalTweet.content)) {
                title = tweet.value.originalTweet!.content!.substring(0, MAX_TITLE_LENGTH)
            } else {
                tweet.value.originalTweet!.attachments?.forEach((element: any) => {
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
    console.log('[tweetId watcher] tweetId changed from', oldValue, 'to', newValue);
    if (newValue && oldValue !== newValue) {
        console.log('[tweetId watcher] Reloading tweet data for:', newValue);
        // Clear current tweet and use the same loadDetail function with retry logic
        tweet.value = null
        originTweet.value = null
        isRetweet.value = false
        await loadDetail(0)
        console.log('[tweetId watcher] Finished reloading, tweet.value:', tweet.value);
    } else {
        console.log('[tweetId watcher] No change detected');
    }
});

watch(route, () => {
    nextTick(() => {
        window.scrollTo(0, 0);
    });
});

function linkify(text: string) {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}

// Download prompt functions
function openDownloadModal() {
    showDownloadModal.value = true
}

function closeDownloadModal() {
    showDownloadModal.value = false
}

function openAppStore() {
    window.open('https://apps.apple.com/app/dtweet/id6751131431', '_blank')
}

function openPlayStore() {
    window.open('https://play.google.com/store/apps/details?id=us.fireshare.tweet', '_blank')
}

async function startDirectDownload() {
    if (tweetStore.installApk) {
        isDownloading.value = true
        try {
            await tweetStore.downloadBlob(tweetStore.installApk)
        } catch (error) {
            console.error('Download failed:', error)
        } finally {
            isDownloading.value = false
        }
    }
}

function openInBrowser(url: string) {
    window.open(url, '_blank')
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

// Filter media attachments (image, video, audio only) for the displayed tweet
const displayedTweet = computed(() => {
    return isRetweet.value && originTweet.value ? originTweet.value : tweet.value;
});

const mediaAttachments = computed(() => {
    const attachments = displayedTweet.value?.attachments || [];
    return attachments.filter((attachment: MimeiFileType) => {
        const normalizedType = normalizeMediaType(attachment.type);
        return normalizedType.includes('image') || 
               normalizedType.includes('video') || 
               normalizedType.includes('audio');
    });
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

// Store navigation metadata in sessionStorage to persist across route changes
const navigationMeta = ref<{
    fromComment: boolean;
    parentTweetId: string | undefined;
    parentAuthorId: string | undefined;
} | null>(null);

const updateNavigationMeta = () => {
    try {
        console.log('[updateNavigationMeta] route.query:', route.query);

        // First check if we have navigation metadata in the URL query params
        const fromQuery = {
            fromComment: route.query.fromComment === 'true',
            parentTweetId: route.query.parentTweetId as string | undefined,
            parentAuthorId: route.query.parentAuthorId as string | undefined
        };

        console.log('[updateNavigationMeta] fromQuery:', fromQuery);

        // If we have valid navigation metadata from query params, store it in sessionStorage
        if (fromQuery.fromComment && fromQuery.parentTweetId) {
            console.log('[updateNavigationMeta] Using query params, storing in sessionStorage');
            sessionStorage.setItem('navigationMeta', JSON.stringify(fromQuery));
            navigationMeta.value = fromQuery;
            return;
        }

        console.log('[updateNavigationMeta] No valid query params, checking sessionStorage');

        // Otherwise, check sessionStorage for previously stored metadata
        const stored = sessionStorage.getItem('navigationMeta');
        if (stored) {
            console.log('[updateNavigationMeta] Found in sessionStorage:', stored);
            navigationMeta.value = JSON.parse(stored);
            return;
        }

        console.log('[updateNavigationMeta] No navigation metadata found');
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
    console.log('[TweetDetail] Route query changed, updating navigation meta');
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

function retryLoad() {
    console.log('[TweetDetail] User initiated retry');
    tweetNotFound.value = false;
    loadDetail(0);
}
</script>

<template>
<PageLayout>
    <div v-if="isFromComment" class="back-button mb-2" @click="goBack">
        ← {{ $t('common.back') }}
    </div>
    
    <!-- Tweet not found error - specific message for non-existent tweets -->
    <div v-if="tweetNotFound && !isLoading && hasLoadAttempted && !tweet" class="loading-retry-message text-center my-4">
        <div class="alert alert-warning" role="alert">
            <h5 class="alert-heading">{{ $t('tweet.tweetNotFound') }}</h5>
            <p class="mb-3">{{ $t('tweet.tweetNotFoundDesc') }}</p>
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
                :exclude-tweet-id="tweet.originalTweet?.mid">
            </DetailHeader>
            <DetailHeader class="w-100" v-else-if="!isRetweet && tweet.author" :author="tweet.author" :timestamp="tweet.timestamp"
                :exclude-tweet-id="tweet.mid">
            </DetailHeader>
        </div>
        
        <div v-if="isRetweet" class="card-body" id="content">

            <p v-if="originTweet.content" class="card-text" v-html="linkify(originTweet.content)"></p>

            <div v-if="mediaAttachments.length > 0" :class="['media-attachments', { 'media-attachments--multi': mediaAttachments.length > 1 }]">
                <MediaView v-for="(media, index) in mediaAttachments" :key="index" :media=media
                    v-bind:tweet="tweet" :autoplay="shouldAutoplay(media, mediaAttachments)" :media-list="mediaAttachments" :media-index="Number(index)" class="img-fluid"></MediaView>
            </div>
            <div v-if='documentAttachments.length > 0' class='document-attachments'>
                <div
                    v-for='(doc, index) in documentAttachments'
                    :key='index'
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
            <p v-if="tweet.content" class="card-text" v-html="linkify(tweet.content)"></p>

            <div v-if="mediaAttachments.length > 0" :class="['media-attachments', { 'media-attachments--multi': mediaAttachments.length > 1 }]">
                <MediaView v-for="(media, index) in mediaAttachments" :key="index" :media=media
                    v-bind:tweet="tweet" :autoplay="shouldAutoplay(media, mediaAttachments)" :media-list="mediaAttachments" :media-index="Number(index)" class="img-fluid">
                </MediaView>
            </div>
            <div v-if='documentAttachments.length > 0' class='document-attachments'>
                <div 
                    v-for='(doc, index) in documentAttachments' 
                    :key='index' 
                    class='document-row'
                    @click='handleDocumentClick($event, doc)'
                >
                    <span class='document-icon'>📄</span>
                    <span class='document-filename'>{{ doc.fileName || $t('tweet.unknownFile') }}</span>
                    <span class='document-size'>{{ formatFileSize(doc.size) }}</span>
                </div>
            </div>

            <!-- quoted tweet -->
            <blockquote v-if="!isRetweet" class="quoted-tweet">
                <TweetView v-if="originTweet" :tweet="originTweet" :is-quoted=true></TweetView>
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
    </div>

    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <LoadingSpinner />
    </div>

    <DownloadModal
        :show="showDownloadModal"
        :isDownloading="isDownloading"
        @close="closeDownloadModal"
        @startDownload="startDirectDownload"
        @openAppStore="openAppStore"
        @openPlayStore="openPlayStore"
        @openBrowser="openInBrowser"
    />

    <!-- Download Button -->
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
            <span class="download-text">{{ $t('download.downloadApp') }}</span>
        </button>
    </div>
</PageLayout>
</template>

<style scoped>
.quoted-tweet {
    margin: 8px 0 8px 56px;
    border: 1px solid #e6ecf0;
    border-radius: 8px;
    overflow: hidden;
}

.comment-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
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
    overflow: hidden;
    max-height: 80vh;
    display: flex;
    align-items: center;
    justify-content: center;
}

.media-attachments :deep(.container) {
    width: 100% !important;
    height: 100% !important;
    max-height: 80vh !important;
    margin: 0 !important;
    padding: 0 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}

.media-attachments :deep(img) {
    max-width: 100% !important;
    max-height: 80vh !important;
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
    max-height: 80vh !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    margin: 0 !important;
    padding: 0 !important;
}

.media-attachments :deep(video) {
    max-width: 100% !important;
    max-height: 80vh !important;
    width: auto !important;
    height: auto !important;
    display: block;
    margin: 0 auto !important;
    padding: 0 !important;
    object-fit: contain;
}

/* Multiple media: vertical list layout */
.media-attachments--multi {
    flex-direction: column;
    align-items: stretch;
    max-height: none;
    overflow: visible;
    gap: 8px;
    width: 100%;
}

.media-attachments--multi :deep(.container),
.media-attachments--multi :deep(img),
.media-attachments--multi :deep(video) {
    width: 100% !important;
    max-height: none !important;
    content-visibility: auto;
}

/* Desktop: ensure video takes at least 80vh */
@media (min-width: 768px) {
    .media-attachments:has(video) {
        min-height: 80vh;
    }

    .media-attachments :deep(.video-container),
    .media-attachments :deep(.video-wrapper) {
        min-height: 80vh !important;
    }

    .media-attachments :deep(video) {
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
    color: #333;
}

.back-button:hover {
    opacity: 0.7;
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
    bottom: 60px;
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
    background: #5a67d8;
    color: #ffffff;
    border: none;
    border-radius: 999px;
    padding: 6px 24px;
    font-size: 1rem;
    font-weight: 500;
    cursor: inherit;
    box-shadow: 0 4px 12px rgba(90, 103, 216, 0.4);
    transition: background 0.2s ease, box-shadow 0.2s ease;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 8px;
}

.download-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    object-fit: contain;
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
        font-size: 0.9rem;
        padding: 5px 20px;
    }

    .download-text {
        font-size: 0.9rem;
    }

    .download-icon {
        width: 20px;
        height: 20px;
    }
}

</style>