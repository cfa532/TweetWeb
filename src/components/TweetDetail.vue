<script lang="ts" setup>
import { ref, onMounted, watch, computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTweetStore } from "@/stores";
import { MediaView, DetailHeader, ItemHeader, TweetView, QRCoder } from "@/views";
import { normalizeMediaType, isWeChatBrowser } from '@/lib';

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
const hasLoadAttempted = ref(false)
const author = ref<User>();

// Download prompt variables
const showDownloadPrompt = ref(false)
const showDownloadModal = ref(false)
const isDownloading = ref(false)
const qrSize = 100

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

// Localization for loading retry message
function getLoadingRetryMessage(): string {
    const language = navigator.language || 'en';

    if (language.startsWith('zh')) {
        return '正在加载推文，6秒后重试...';
    } else if (language.startsWith('ja')) {
        return 'ツイートを読み込んでいます、6秒後に再試行...';
    } else {
        return 'Loading tweet, retrying in 6s...';
    }
}

onMounted(async () => {
    if (sessionStorage["isBot"] != "No" && isWeChatBrowser()) {
        if (confirm(getBotVerificationMessage())) {
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

    // Show download prompt after 2 seconds
    setTimeout(() => {
        showDownloadPrompt.value = true
    }, 2000)

    setTimeout(() => {
        showDownloadPrompt.value = false
    }, 30000)
});
async function loadDetail(retryCount = 0) {
    const maxRetries = 3
    isLoading.value = true
    loadError.value = false
    hasLoadAttempted.value = true

    // Safety timeout: hide spinner after 5 seconds regardless of loading state
    const timeoutId = window.setTimeout(() => {
        isLoading.value = false
        if (!tweet.value) {
            loadError.value = true
        }
    }, 5000)

    try {
        let s = sessionStorage.getItem("tweetDetail")
        if (s) {
            tweet.value = JSON.parse(s)
            // Render tweet immediately without waiting for author
            await showTweet(timeoutId)
            // Load author asynchronously (only if not already loaded)
            if (!tweet.value.author && tweet.value.authorId) {
                tweetStore.getUser(tweet.value.authorId).then(user => {
                    if (user && tweet.value) {
                        tweet.value.author = user
                    }
                }).catch(error => {
                    console.warn('[TweetDetail] Failed to load author:', error)
                })
            }
        }
        else {
            // Fetch tweet if it is not in session already.
            // Use racing for faster loading on TweetDetail page
            console.log('[TweetDetail TIMING] Calling getTweet...', new Date().toISOString())
            tweet.value = await tweetStore.getTweet(tweetId.value, authorId.value, true) as Tweet
            console.log('[TweetDetail TIMING] ✅ Tweet received and set, Vue will render now:', new Date().toISOString())

            if (!tweet.value) {
                throw new Error('Tweet not found (null response)')
            }

            loadError.value = false
            await showTweet(timeoutId)
        }
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

        if (retryCount < maxRetries) {
            console.log(`[TweetDetail] Retrying in 2 seconds... (${retryCount + 1}/${maxRetries})`)
            // Show retry message to user
            loadError.value = true
            clearTimeout(timeoutId)
            isLoading.value = false

            setTimeout(() => {
                loadDetail(retryCount + 1)
            }, 2000)
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
        sessionStorage.setItem("tweetDetail", JSON.stringify(tweet.value))

        // Tweet content is ready to display - set loading to false early
        document.title = formattedTitle.value
        if (timeoutId) clearTimeout(timeoutId)
        isLoading.value = false

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

        // Fire and forget - let these run in background without blocking
        Promise.allSettled(loadPromises).then(() => {
            console.log('[TweetDetail] Background loading operations completed')
        }).catch(error => {
            console.warn('[TweetDetail] Some background operations failed:', error)
        })
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

function shareSummaryText(): string {
    const source = preferredSummarySource()
    if (!source) {
        return 'Open this tweet on Tweet.'
    }
    if (!tweetStore.isEmptyString(source.content)) {
        const content = source.content!.trim()
        return content.length > 80 ? `${content.substring(0, 80)}…` : content
    }
    if (!tweetStore.isEmptyString(source.title)) {
        const title = source.title!.trim()
        return title.length > 80 ? `${title.substring(0, 80)}…` : title
    }
    if (source.attachments?.length) {
        return source.attachments.map((attachment: MimeiFileType) => `[${attachment.type}]`).join(' ')
    }
    return 'Open this tweet on Tweet.'
}

function preferredSummarySource(): Tweet | undefined {
    if (isRetweet.value && originTweet.value) {
        return originTweet.value
    }
    return tweet.value
}

function resolveAttachmentURL(attachment: MimeiFileType, tweetContext: Tweet): string | null {
    const mid = attachment.mid
    if (!mid) {
        return null
    }
    if (mid.startsWith('http://') || mid.startsWith('https://')) {
        return mid
    }
    const authorBase = tweetContext.author?.hostUrl
    const fallback = authorBase ?? window.location.origin
    try {
        return tweetStore.getMediaUrl(mid, fallback)
    } catch (error) {
        console.warn('[preview] Failed to resolve attachment URL', error)
        return null
    }
}

// Download prompt computed properties
const downloadText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '下载APP获得最佳体验'
    } else if (language.startsWith('ja')) {
        return 'ネイティブアプリで最高の体験を'
    } else {
        return '下载APP获得最佳体验'
    }
})

const directDownloadText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '直接下载安卓 APK'
    } else if (language.startsWith('ja')) {
        return '直接ダウンロード Android APK'
    } else {
        return 'Download Android APK'
    }
})

const apkText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '在浏览器中打开链接'
    } else if (language.startsWith('ja')) {
        return 'ブラウザでリンクを開く'
    } else {
        return 'Open the link in browser'
    }
})

const downloadPageUrl = computed(() => {
    return `${window.location.origin}/apk`
})

const downloadingText = computed(() => {
    const language = navigator.language || 'en'
    
    if (language.startsWith('zh')) {
        return '下载中...'
    } else if (language.startsWith('ja')) {
        return 'ダウンロード中...'
    } else {
        return 'Downloading...'
    }
})

watch(tweetId, async (newValue, oldValue)=>{
    if (newValue && oldValue !== newValue) {
        // Clear current tweet and use the same loadDetail function with retry logic
        tweet.value = null
        originTweet.value = null
        isRetweet.value = false
        await loadDetail(0)
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

function addComment(tweetId: MimeiId) {
    router.push({ name: 'post', params: { tweetId: tweetId } })
}

async function toggleLike(t: Tweet) {
    if (!tweetStore.loginUser) {
        router.push({ name: 'login' })
        return
    }
    tweet.value = await tweetStore.toggleFavorite(t.mid)
}
async function toggleBookmark(t: Tweet) {
    if (!tweetStore.loginUser) {
        router.push({ name: 'login' })
        return
    }
    tweet.value  = await tweetStore.toggleBookmark(t.mid)
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

function openInBrowser() {
    window.open(downloadPageUrl.value, '_blank')
}

function isVideoMedia(media?: MimeiFileType) {
    const type = media?.type?.toLowerCase() || ''
    return type.includes('video') || type === 'hls_video'
}

function shouldAutoplay(media: MimeiFileType, mediaList?: MimeiFileType[]) {
    if (!mediaList?.length) return false
    const firstVideo = mediaList.find(item => isVideoMedia(item))
    return !!firstVideo && firstVideo.mid === media.mid
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
    if (!bytes || bytes === 0) return '0 Bytes';
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

const isFromComment = computed(() => !!route.query.fromComment);
const parentTweetId = computed(() => route.query.parentTweetId as string | undefined);
const parentAuthorId = computed(() => route.query.parentAuthorId as string | undefined);

function goBack() {
    if (parentTweetId.value && parentAuthorId.value) {
        router.push(`/tweet/${parentTweetId.value}/${parentAuthorId.value}`);
    } else {
        router.back();
    }
}
</script>

<template>
<div class="row justify-content-start align-items-start">
<div class="col-sm-12 col-md-10 col-lg-8" style="background-color:aliceblue;">
    <div v-if="isFromComment" class="back-button mb-2" @click="goBack">
        ← Back to Tweet
    </div>
    
    <!-- Loading retry message - only show after load attempt fails -->
    <div v-if="loadError && !isLoading && hasLoadAttempted && !tweet" class="loading-retry-message text-center my-4">
        <div class="spinner-border text-primary mb-2" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
        <p class="mb-0">{{ getLoadingRetryMessage() }}</p>
    </div>
    
    <div v-if="tweet" class="card mb-1">
        <div class="card-header d-flex align-items-center">
            <DetailHeader v-if="isRetweet && tweet.originalTweet?.author && tweet.author" :author="tweet.originalTweet.author" :timestamp="tweet.timestamp"
                :is-retweet="isRetweet" :by="tweet.author.username">
            </DetailHeader>
            <DetailHeader v-else-if="!isRetweet && tweet.author" :author="tweet.author" :timestamp="tweet.timestamp"></DetailHeader>
        </div>
        
        <!-- App Download Prompt for All Users -->
        <div v-if="showDownloadPrompt" class="download-prompt" @click="openDownloadModal">
            <div class="prompt-content">
                <div class="prompt-text">
                    <p>{{ downloadText }} ⬇️</p>
                </div>
            </div>
        </div>
        
        <div v-if="isRetweet" class="card-body" id="content">

            <p v-if="originTweet.content" class="card-text" v-html="linkify(originTweet.content)"></p>

            <div v-if="mediaAttachments.length > 0" class="media-attachments">
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
                    <span class='document-filename'>{{ doc.fileName || 'Unknown file' }}</span>
                    <span class='document-size'>{{ formatFileSize(doc.size) }}</span>
                </div>
            </div>
            <div class='icon-row d-flex justify-content-around mt-1 mb-2'>
                <div class='icon-item d-flex align-items-center'>
                    <img @click="toggleLike(originTweet)" src='/src/ic_heart.png' alt='Favorite' class='icon' />
                    <span class='icon-number'>{{ originTweet.likeCount > 0 ? originTweet.likeCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img @click="toggleBookmark(originTweet)" src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                    <span class='icon-number'>{{ originTweet.bookmarkCount > 0 ? originTweet.bookmarkCount : null
                        }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img @click="addComment(originTweet.mid)" src='/src/ic_notice.png' alt='Comment' class='icon' />
                    <span class='icon-number'>{{ originTweet.commentCount > 0 ? originTweet.commentCount : null
                        }}</span>
                </div>
            </div>
        </div>
        <div v-else class="card-body">
            <p v-if="tweet.content" class="card-text" v-html="linkify(tweet.content)"></p>

            <div v-if="mediaAttachments.length > 0" class="media-attachments">
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
                    <span class='document-filename'>{{ doc.fileName || 'Unknown file' }}</span>
                    <span class='document-size'>{{ formatFileSize(doc.size) }}</span>
                </div>
            </div>

            <!-- quoted tweet -->
            <blockquote v-if="!isRetweet">
                <TweetView v-if="originTweet" :tweet="originTweet" :is-quoted=true></TweetView>
            </blockquote>

            <div class='icon-row d-flex justify-content-around mt-1 mb-2'>
                <div class='icon-item d-flex align-items-center'>
                    <img @click="toggleLike(tweet)" src='/src/ic_heart.png' alt='Favorite' class='icon' />
                    <span class='icon-number'>{{ tweet.likeCount > 0 ? tweet.likeCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img @click="toggleBookmark(tweet)" src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                    <span class='icon-number'>{{ tweet.bookmarkCount > 0 ? tweet.bookmarkCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img @click="addComment(tweet.mid)" src='/src/ic_notice.png' alt='Comment' class='icon' />
                    <span class='icon-number'>{{ tweet.commentCount > 0 ? tweet.commentCount : null }}</span>
                </div>
            </div>
        </div>
    </div>

    <!-- Show comments of the original tweet if it is a retweet -->
    <div v-if="tweet">
        <div v-if="isRetweet">
            <TweetView v-for="comment in originTweet.comments.filter((c: any) => c.author)" :key="comment.mid" :tweet="comment" :is-comment="true" :parent-tweet="originTweet" class="comment card mb-1 mt-3" />
        </div>
        <!-- Show comments of the tweet -->
        <div v-else>
            <TweetView v-for="comment in tweet.comments.filter((c: any) => c.author)" :key="comment.mid" :tweet="comment" :is-comment="true" :parent-tweet="tweet" class="comment card mb-1 mt-3" />
        </div>
    </div>

    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
    
    <!-- Download Modal Popup -->
    <div v-if="showDownloadModal" class="modal-overlay" @click="closeDownloadModal">
        <div class="modal-content" @click.stop>
            <div class="modal-body">
                <div class="platform-options">
                    <!-- Direct Download -->
                    <div class="platform-option">
                        <div class="platform-qr" @click="startDirectDownload">
                            <QRCoder :url="downloadPageUrl" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                        <div class="platform-info">
                            <p v-if="isDownloading">{{ downloadingText }}</p>
                            <a v-else href="#" @click.prevent="openInBrowser" class="browser-link">{{ apkText }}</a>
                        </div>
                        <div v-if="isDownloading" class="download-spinner">
                            <span class="spinner-border spinner-border-sm" role="status"></span>
                        </div>
                    </div>
                    
                    <!-- iOS/App Store -->
                    <div class="platform-option">
                        <div class="platform-icon">
                            <img src="/src/apple.png" alt="Apple" height="48" width="48" />
                        </div>
                        <div class="platform-qr" @click="openAppStore">
                            <QRCoder url="https://apps.apple.com/app/dtweet/id6751131431" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                    </div>
                    
                    <!-- Android/Google Play -->
                    <div class="platform-option">
                        <div class="platform-icon">
                            <img src="/src/android.png" alt="Android" height="48" width="48" />
                        </div>
                        <div class="platform-qr" @click="openPlayStore">
                            <QRCoder url="https://play.google.com/store/apps/details?id=us.fireshare.tweet" :size="qrSize" :logoSize="20" :disableModal="true"></QRCoder>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>
</div>
</template>

<style scoped>
/* Loading retry message styling */
.loading-retry-message {
    padding: 2rem 1rem;
    color: #495057;
    background-color: transparent;
}

.loading-retry-message p {
    font-size: 1rem;
    color: #6c757d;
}

.card {
    width: 100%;
    margin: 0px 0px 30px 5px;
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
}

.media-attachments :deep(.container) {
    width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
}

.media-attachments :deep(img),
.media-attachments :deep(video),
.media-attachments :deep(.video-container),
.media-attachments :deep(.video-wrapper),
.media-attachments :deep(.video) {
    width: 100% !important;
    display: block;
    margin: 0 !important;
    padding: 0 !important;
    object-fit: cover;
}

.rounded-circle {
    width: 40px;
    height: 40px;
}

.icon-item {
    position: relative;
    /* Establishes a positioning context for the number */
    display: flex;
    flex-direction: column;
    /* Stacks the icon and number vertically */
    align-items: center;
}

.icon-number {
    position: absolute;
    /* Positions the number on top of the icon */
    bottom: -1px;
    /* Positions the number slightly below the icon */
    right: -15px;
    /* Aligns the number to the right edge of the icon */
    font-size: 15px;
    /* Adjust the font size for better visibility */
    color: rgba(0, 0, 0, 0.78);
    /* Change the color to ensure visibility */
}

.icon-row {
    display: flex;
    justify-content: space-around;
}

.icon {
    width: 18px;
    /* Set a uniform width for icons */
    height: 18px;
    /* Set a uniform height for icons */
    transition: transform 0.3s;
    cursor: pointer;
}

.icon:hover {
    transform: scale(1.1);
    /* Slightly enlarge the icon on hover */
}

.icon-item span {
    margin-top: 5px;
    /* Adds space between the icon and the number */
    color: rgba(0, 0, 0, 0.775);
    /* Change the color to ensure visibility */
    font-weight: bold;
    /* Makes the number stand out */
    pointer-events: none;
    /* Ensures the number doesn't interfere with icon hover */
}

/* App Download Prompt Styles */
.download-prompt {
    position: relative;
    width: 100%;
    background: #1a1a1a;
    color: #ffffff;
    padding: 0 15px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    cursor: pointer;
    transition: transform 0.2s ease;
    animation: rotateToVertical 0.6s ease-out;
    transform-style: preserve-3d;
    perspective: 1000px;
}

.download-prompt:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.prompt-content {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    max-width: 100%;
    margin: 0;
    gap: 8px;
}

.prompt-text p {
    margin: 0;
    font-size: 1.0rem;
    font-weight: 500;
    opacity: 0.9;
    line-height: 1.4;
}

.prompt-icon {
    font-size: 1rem;
    flex-shrink: 0;
}

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
    max-width: 600px;
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

@keyframes rotateToVertical {
    from {
        transform: rotateX(90deg);
        opacity: 0;
    }
    to {
        transform: rotateX(0deg);
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
</style>