<script lang="ts" setup>
import { ref, onMounted, watch, computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTweetStore } from "@/stores";
import { MediaView, DetailHeader, ItemHeader, TweetView, QRCoder } from "@/views";

const route = useRoute();
const router = useRouter();
const tweetStore = useTweetStore()
const tweetId = computed(()=>route.params.tweetId as MimeiId)
const authorId = computed(()=>route.params.authorId as MimeiId | undefined)
const tweet = ref()
const originTweet = ref()
const isRetweet = ref(false)
const isLoading = ref(false)
const author = ref<User>();
const DEFAULT_PREVIEW_IMAGE = `${window.location.origin}/ic_splash.png`
const videoPreviewCache = new Map<string, string>()

// Download prompt variables
const showDownloadPrompt = ref(false)
const showDownloadModal = ref(false)
const isDownloading = ref(false)
const qrSize = 100

onMounted(async () => {
    if (sessionStorage["isBot"] != "No") {
        if (confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!")) {
            sessionStorage["isBot"] = "No"
            loadDetail()
        } else {
            history.go(-1)
        }
    } else {
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
async function loadDetail() {
    isLoading.value = true
    let s = sessionStorage.getItem("tweetDetail")
    if (s) {
        tweet.value = JSON.parse(s)
        tweet.value.author = await tweetStore.getUser(tweet.value.author.mid)
        showTweet()
    }
    else {
        // Fetch tweet if it is not in session already.
        tweet.value = await tweetStore.getTweet(tweetId.value, authorId.value) as Tweet
        if (!tweet.value) {
            window.setTimeout(() => {
                window.location.reload()
            }, 5000)                        // wait 5s before reload
        } else {
            showTweet()
        }
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
}
async function showTweet() {
    sessionStorage.setItem("tweetDetail", JSON.stringify(tweet.value))
    if (authorId.value) {
        author.value = await tweetStore.getUser(authorId.value);
    } else if (tweet) {
        author.value = await tweetStore.getUser(tweet.value.author.mid);
    }
    // load orginalTweet
    if (tweet.value.originalTweetId) {
        originTweet.value = await tweetStore.getTweet(tweet.value.originalTweetId, tweet.value.originalAuthorId!)
        if (!tweet.value.content && !tweet.value.attachments) {
            isRetweet.value = true
            await tweetStore.loadComments(originTweet.value)
        }
    } else {
        await tweetStore.loadComments(tweet.value)
    }
    document.title = formattedTitle.value
    tweetStore.addFollowing(tweet.value.author.mid)
    isLoading.value = false
    await refreshShareMetadata()
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

async function resolvePreviewImage(): Promise<string> {
    const sourceTweet = preferredSummarySource()
    if (!sourceTweet?.attachments?.length) {
        return DEFAULT_PREVIEW_IMAGE
    }

    const firstImage = sourceTweet.attachments.find((attachment: MimeiFileType) =>
        attachment.type?.toLowerCase().includes('image')
    )
    if (firstImage) {
        const imageUrl = resolveAttachmentURL(firstImage, sourceTweet)
        if (imageUrl) {
            return imageUrl
        }
    }

    const firstVideo = sourceTweet.attachments.find((attachment: MimeiFileType) =>
        isVideoAttachment(attachment)
    )
    if (firstVideo) {
        const cacheKey = firstVideo.mid
        if (cacheKey && videoPreviewCache.has(cacheKey)) {
            return videoPreviewCache.get(cacheKey)!
        }

        const videoUrl = resolveAttachmentURL(firstVideo, sourceTweet)
        if (videoUrl) {
            const posterUrl = await findExistingVideoPoster(videoUrl)
            if (posterUrl) {
                if (cacheKey) {
                    videoPreviewCache.set(cacheKey, posterUrl)
                }
                return posterUrl
            }
            const generated = await captureVideoFrame(videoUrl)
            if (generated) {
                if (cacheKey) {
                    videoPreviewCache.set(cacheKey, generated)
                }
                return generated
            }
        }
    }

    return DEFAULT_PREVIEW_IMAGE
}

async function refreshShareMetadata() {
    if (!tweet.value) {
        return
    }
    const title = formattedTitle.value || 'Tweet'
    const summary = shareSummaryText()
    const previewUrl = await resolvePreviewImage()
    const currentUrl = window.location.href

    updateMetaProperty('og:title', title)
    updateMetaProperty('og:description', summary)
    updateMetaProperty('og:image', previewUrl)
    updateMetaProperty('og:url', currentUrl)
    updateMetaProperty('og:type', 'article')

    updateMetaName('description', summary)
    updateMetaName('twitter:title', title)
    updateMetaName('twitter:description', summary)
    updateMetaName('twitter:image', previewUrl)
    updateMetaName('twitter:card', 'summary_large_image')
}

function updateMetaProperty(property: string, content: string) {
    if (!content) {
        return
    }
    let meta = document.querySelector(`meta[property=\"${property}\"]`)
    if (!meta) {
        meta = document.createElement('meta')
        meta.setAttribute('property', property)
        document.head.appendChild(meta)
    }
    meta.setAttribute('content', content)
}

function updateMetaName(name: string, content: string) {
    if (!content) {
        return
    }
    let meta = document.querySelector(`meta[name="${name}"]`)
    if (!meta) {
        meta = document.createElement('meta')
        meta.setAttribute('name', name)
        document.head.appendChild(meta)
    }
    meta.setAttribute('content', content)
}

function isVideoAttachment(attachment: MimeiFileType): boolean {
    const type = attachment.type?.toLowerCase() || ''
    return type.includes('video') || type === 'hls_video'
}

async function findExistingVideoPoster(videoUrl: string): Promise<string | null> {
    const candidates = buildPosterCandidates(videoUrl)
    for (const candidate of candidates) {
        try {
            const response = await fetch(candidate, { method: 'HEAD', cache: 'force-cache' })
            if (response.ok) {
                return candidate
            }
        } catch (error) {
            console.warn('[preview] Unable to probe video poster', candidate, error)
        }
    }
    return null
}

function buildPosterCandidates(videoUrl: string): string[] {
    const candidates = new Set<string>()
    try {
        const parsed = new URL(videoUrl, window.location.origin)
        const path = parsed.pathname
        const base = `${parsed.origin}${path}`
        const directory = base.substring(0, base.lastIndexOf('/'))
        const filename = base.substring(base.lastIndexOf('/') + 1)

        if (filename.endsWith('master.m3u8') || filename.endsWith('playlist.m3u8')) {
            candidates.add(`${directory}/poster.jpg`)
            candidates.add(`${directory}/poster.png`)
            candidates.add(`${directory}/thumbnail.jpg`)
            candidates.add(`${directory}/preview.jpg`)
            candidates.add(`${directory}/cover.jpg`)
        }

        const extensionMatch = filename.match(/\.(mp4|mov|m4v|webm|ts)$/i)
        if (extensionMatch) {
            candidates.add(base.replace(extensionMatch[0], '.jpg'))
            candidates.add(base.replace(extensionMatch[0], '.png'))
        }

        candidates.add(`${base}.jpg`)
        candidates.add(`${base}.png`)
    } catch (error) {
        console.warn('[preview] Failed to build poster candidates', error)
    }
    return Array.from(candidates)
}

async function captureVideoFrame(videoUrl: string): Promise<string | null> {
    return new Promise((resolve) => {
        const video = document.createElement('video')
        const canvas = document.createElement('canvas')

        const cleanup = () => {
            video.pause()
            video.removeAttribute('src')
            video.load()
        }

        const fail = (error?: Event) => {
            console.warn('[preview] Unable to capture frame', error)
            cleanup()
            resolve(null)
        }

        video.crossOrigin = 'anonymous'
        video.muted = true
        video.playsInline = true
        video.preload = 'auto'
        video.src = `${videoUrl}#t=1`

        video.addEventListener('error', fail, { once: true })
        video.addEventListener('loadeddata', () => {
            try {
                canvas.width = video.videoWidth || 640
                canvas.height = video.videoHeight || 360
                const ctx = canvas.getContext('2d')
                if (!ctx) {
                    fail()
                    return
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                const dataUrl = canvas.toDataURL('image/png')
                cleanup()
                resolve(dataUrl)
            } catch (error) {
                fail(error as unknown as Event)
            }
        }, { once: true })
    })
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
        let t = await tweetStore.getTweet(newValue, authorId.value)
        if (t) {
            console.log(t)
            tweet.value = t
            sessionStorage.setItem("tweetDetail", JSON.stringify(tweet.value))
            await showTweet()
            // router.push(`/tweet/${tweetId.value}/${authorId.value}`)
        }
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
    <div v-if="tweet" class="card mb-1">
        <div class="card-header d-flex align-items-center">
            <DetailHeader v-if="isRetweet" :author="tweet.originalTweet.author" :timestamp="tweet.timestamp"
                :is-retweet="isRetweet" :by="tweet.author?.username">
            </DetailHeader>
            <DetailHeader v-else :author="tweet.author" :timestamp="tweet.timestamp"></DetailHeader>
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

            <div v-if="originTweet.attachments?.length" class="media-attachments">
                <MediaView v-for="(media, index) in originTweet.attachments" :key="index" :media=media
                    v-bind:tweet="tweet" :autoplay="shouldAutoplay(media, originTweet.attachments)" :media-list="originTweet.attachments" :media-index="index" class="img-fluid mb-1"></MediaView>
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

            <div v-if="tweet.attachments?.length" class="media-attachments">
                <MediaView v-for="(media, index) in tweet.attachments" :key="index" :media=media
                    v-bind:tweet="tweet" :autoplay="shouldAutoplay(media, tweet.attachments)" :media-list="tweet.attachments" :media-index="index" class="img-fluid">
                </MediaView>
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
            <TweetView v-for="comment in originTweet.comments" :key="comment.mid" :tweet="comment" :is-comment="true" :parent-tweet="originTweet" class="comment card mb-1 mt-3" />
        </div>
        <!-- Show comments of the tweet -->
        <div v-else>
            <TweetView v-for="comment in tweet.comments" :key="comment.mid" :tweet="comment" :is-comment="true" :parent-tweet="tweet" class="comment card mb-1 mt-3" />
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
    max-width: 100%;
}

/* Mobile: Full-width media */
@media (max-width: 767px) {
    .media-attachments {
        margin-left: -8px;
        margin-right: -8px;
        width: calc(100% + 16px);
        max-width: calc(100% + 16px);
    }
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
</style>