<script lang="ts" setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore } from "@/stores";
import { MediaView, AppHeader, ItemHeader, TweetView } from "@/views";

const route = useRoute();
const tweetStore = useTweetStore()
const tweetId = route.params.tweetId as string
const authorId = route.params.authorId as string | undefined
const tweet = ref()
const originTweet = ref()
const isRetweet = ref(false)
let countdownInterval: number | undefined;
const isLoading = ref(false)

onMounted(async () => {
    document.addEventListener("DOMContentLoaded", function() {
        const contentElement = document.getElementById('content');
        const paragraphs = contentElement?.getElementsByClassName('card-text');
        if (paragraphs)
            for (let i = 0; i < paragraphs.length; i++) {
                const paragraph = paragraphs[i];
                paragraph.innerHTML = linkify(paragraph.innerHTML); // display url as link
            }
    });
    
    // Fetch tweet if it is not in session already.
    isLoading.value = true
    let s = sessionStorage.getItem("tweetDetail")
    if (s)
        tweet.value = JSON.parse(s)
    if (!tweet.value) {
        tweet.value = await tweetStore.getTweet(tweetId, authorId) as Tweet
    }
    console.log(tweet.value)
    if (!tweet.value) {
        window.setInterval(()=>{
            window.location.reload()
        }, 5000)
    }
    document.title = tweet.value.title ? tweet.value.title : ""
    if (tweetStore.isEmptyString(document.title)) {
        if (!tweetStore.isEmptyString(tweet.value.content)) {
            document.title = tweet.value.content.substring(20)
        } else {
            if (tweet.value.originalTweetId) {
                if (!tweetStore.isEmptyString(tweet.value.originTweet.content)) {
                    document.title = tweet.value.originTweet.content.substring(20)
                } else {
                    tweet.value.originTweet.attachments.forEach((element: any) => {
                        document.title += '['+ element.type +']'
                    });
                }
            } else {
                tweet.value.attachments.forEach((element: any) => {
                    document.title += '['+ element.type +']'
                });
            }
        }
    }

    if (tweet.value.originalTweetId) {
        originTweet.value = await tweetStore.getTweet(tweet.value.originalTweetId)
        if (!tweet.value.content && !tweet.value.attachments) {
            isRetweet.value = true
            document.title = originTweet.value.title
        }
    }

    if (isRetweet.value)
        await tweetStore.loadComments(originTweet.value)
    else
        await tweetStore.loadComments(tweet.value)
    isLoading.value = false
});
onUnmounted(() => {
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
});
function linkify(text: string) {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}
</script>

<template>
    <AppHeader />
    <div v-if="tweet" class="card mb-1">
        <div class="card-header d-flex align-items-center">
            <ItemHeader v-if="isRetweet" :tweet="originTweet" :is-retweet="isRetweet" :by="tweet.author?.username">
            </ItemHeader>
            <ItemHeader v-else :tweet="tweet"></ItemHeader>
        </div>
        <div v-if="isRetweet" class="card-body" id="content">
            <p class="card-text" v-html="linkify(originTweet.content)"></p>
            <div v-if="originTweet.attachments?.length" class="media-attachments">
                <MediaView v-for="(media, index) in originTweet.attachments" :key="index" v-bind=media
                    class="img-fluid mb-2"></MediaView>
            </div>
            <div class='icon-row d-flex justify-content-around mt-1'>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_heart.png' alt='Favorite' class='icon' />
                    <span class='icon-number'>{{ originTweet.likeCount > 0 ? originTweet.likeCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                    <span class='icon-number'>{{ originTweet.bookmarkCount > 0 ? originTweet.bookmarkCount : null
                        }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_notice.png' alt='Forward' class='icon' />
                    <span class='icon-number'>{{ originTweet.commentCount > 0 ? originTweet.commentCount : null
                        }}</span>
                </div>
            </div>
        </div>
        <div v-else class="card-body">
            <p class="card-text" v-html="linkify(tweet.content)"></p>
            <div v-if="tweet.attachments?.length" class="media-attachments">
                <MediaView v-for="(media, index) in tweet.attachments" :key="index" v-bind=media class="img-fluid mb-2">
                </MediaView>
            </div>

            <!-- quoted tweet -->
            <blockquote v-if="!isRetweet">
                <TweetView v-if="originTweet" :tweet="originTweet" :is-quoted=true></TweetView>
            </blockquote>

            <div class='icon-row d-flex justify-content-around mt-1'>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_heart.png' alt='Favorite' class='icon' />
                    <span class='icon-number'>{{ tweet.likeCount > 0 ? tweet.likeCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                    <span class='icon-number'>{{ tweet.bookmarkCount > 0 ? tweet.bookmarkCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_notice.png' alt='Forward' class='icon' />
                    <span class='icon-number'>{{ tweet.commentCount > 0 ? tweet.commentCount : null }}</span>
                </div>
            </div>
        </div>
    </div>

    <div v-if="tweet">
        <div v-if="isRetweet" v-for="(comment, index) in originTweet.comments" :key="index" class="comment card mb-1 mt-3">
            <div class="card-header d-flex align-items-center">
                <ItemHeader :tweet="comment"></ItemHeader>
            </div>
            <div class="card-body">
                <p class="card-text">{{ comment.content }}</p>
                <div v-if="comment.attachments?.length" class="media-attachments">
                    <MediaView v-for="(media, index) in comment.attachments" :key="index" v-bind=media
                        class="img-fluid mb-2"></MediaView>
                </div>
            </div>
        </div>
        <div v-else v-for="(comment, index1) in tweet.comments" :key="index1" class="comment card mb-1 mt-3">
            <div class="card-header d-flex align-items-center">
                <ItemHeader :tweet="comment"></ItemHeader>
            </div>
            <div class="card-body">
                <p class="card-text">{{ comment.content }}</p>
                <div v-if="comment.attachments?.length" class="media-attachments">
                    <MediaView v-for="(media, index) in comment.attachments" :key="index" v-bind=media
                        class="img-fluid mb-2"></MediaView>
                </div>
            </div>
        </div>
    </div>
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</template>

<style scoped>
.card {
    width: 100%;
    margin: 0px 0px 30px 10px;
}

.card-header {
    margin: 0px;
    padding: auto;
}

.card-body {
    margin: 0px;
    padding: auto;
    padding-top: 0px;
}

.card-text {
    text-align: left;
    font-size: medium;
    white-space: pre-wrap;
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
    margin-top: 0px;
    padding-top: 0px;
    max-width: 100%;
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
</style>