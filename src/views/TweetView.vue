<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { MediaView, ItemHeader } from "@/views";
import { useTweetStore } from "@/stores";

const tweetStore = useTweetStore()
const router = useRouter()
const props = defineProps({ 
    tweet: {type: Object as PropType<Tweet>, required: true},
    isQuoted: {type: Boolean, required: false, default: false}
});
const tweet = ref(props.tweet)
const originTweet = ref()
const isRetweet = ref(false)

onMounted(async () => {
    if (tweet.value.originalTweetId) {
        originTweet.value = await tweetStore.fetchTweet(tweet.value.originalTweetId, tweet.value.originalAuthorId)
        if (originTweet.value) {
            tweet.value.originalTweet = originTweet.value
            if (!tweet.value.content && !tweet.value.attachments) {
                // A retweet. Rendering original tweet in the place of tweet.
                tweet.value = originTweet.value
                isRetweet.value = true
            }
        } else {
            // we are retweeting a non-exist tweet. Exit
            return
        }
    }
});
function openDetailView() {
    // Route to the tweet detail page using the tweet ID
    sessionStorage.setItem("tweetDetail", JSON.stringify(tweet.value))
    router.push(`/tweet/${tweet.value.mid}/${tweet.value.author.mid}`);
};
function linkify(text: string) {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}
</script>

<template>
    <div @click.prevent="openDetailView" class="card ms-1">
        <div class="card-header d-flex align-items-start">
            <ItemHeader v-if="isRetweet" :tweet="originTweet" :author="originTweet.author" :timestamp="tweet.timestamp as number"
                :is-retweet="isRetweet" :by="tweet.author?.username">
            </ItemHeader>
            <ItemHeader v-else :author="tweet.author" :tweet="tweet" :timestamp="tweet.timestamp as number"></ItemHeader>
        </div>
        <div v-if="isRetweet" class="card-body">
            <p v-if="originTweet.content" class="card-text" v-html="linkify(originTweet.content)"></p>
            <div v-if="originTweet.attachments?.length" class="media-attachments">
                <div v-if="originTweet.attachments.length === 1" class="single-attachment">
                    <MediaView v-bind="originTweet.attachments[0]" class="img-fluid"></MediaView>
                </div>
                <div v-else class="multiple-attachments">
                    <MediaView v-for="(media, index) in originTweet.attachments.slice(0, 4)" v-bind="media" :key="index" class="img-fluid"></MediaView>
                </div>
            </div>
            <div class='icon-row d-flex justify-content-around mb-2'>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_heart.png' alt='Favorite' class='icon' />
                    <span class='icon-number'>{{ originTweet.likeCount > 0 ? originTweet.likeCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                    <span class='icon-number'>{{ originTweet.bookmarkCount > 0 ? originTweet.bookmarkCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_notice.png' alt='Forward' class='icon' />
                    <span class='icon-number'>{{ originTweet.commentCount > 0 ? originTweet.commentCount : null }}</span>
                </div>
            </div>
        </div>
        <div v-else class="card-body">
            <p v-if="tweet.content" class="card-text" v-html="linkify(tweet.content)"></p>
            <div v-if="tweet.attachments?.length" class="media-attachments">
                <div v-if="tweet.attachments.length === 1" class="single-attachment">
                    <MediaView v-bind="tweet.attachments[0]" class="img-fluid"></MediaView>
                </div>
                <div v-else class="multiple-attachments">
                    <MediaView v-for="(media, index) in tweet.attachments.slice(0, 4)" :key="index" v-bind="media" class="img-fluid"></MediaView>
                </div>
            </div>

            <!-- quoted tweet -->
            <blockquote v-if="!isRetweet">
                <TweetView v-if="originTweet" :tweet="originTweet" :is-quoted=true></TweetView>
            </blockquote>

            <div v-if="!isQuoted" class='icon-row d-flex justify-content-around mb-2'>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_heart.png' alt='Favorite' class='icon' />
                    <span class='icon-number'>{{ tweet.likeCount }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                    <span class='icon-number'>{{ tweet.bookmarkCount }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_notice.png' alt='Forward' class='icon' />
                    <span class='icon-number'>{{ tweet.commentCount }}</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.media-attachments {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
}

.single-attachment {
    width: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
}

.multiple-attachments {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    grid-template-rows: repeat(2, 1fr);
    gap: 2px;
}

.multiple-attachments .img-fluid {
    width: 100%;
    height: 0;
    padding-bottom: 100%; /* This creates a square aspect ratio */
    object-fit: cover; /* Ensures the image covers the entire square */
    object-position: center; /* Centers the image within the square */
    display: block; /* Ensures the element is treated as a block-level element */
    overflow: hidden; /* Ensures no overflow is visible */
  }

.card {
    width: 100%;
    margin: 0px 0px 15px 0px;
}

.card-header {
    margin: 0px;
    padding: 0px 8px;
    cursor: pointer;
}

.card-body {
    margin: 0px;
    padding: 0px;
}

.card-text {
    text-align: left;
    font-size: medium;
    white-space: pre-wrap;
    padding: 4px 8px;
}

.card-text a {
    color: blue;
    text-decoration: underline;
}

.icon-item {
    position: relative; /* Establishes a positioning context for the number */
    display: flex;
    flex-direction: column; /* Stacks the icon and number vertically */
    align-items: center;
}

.icon-number {
    position: absolute; /* Positions the number on top of the icon */
    bottom: -1px; /* Positions the number slightly below the icon */
    right: -15px; /* Aligns the number to the right edge of the icon */
    font-size: 15px; /* Adjust the font size for better visibility */
    color: rgba(0, 0, 0, 0.819); /* Change the color to ensure visibility */
}

.icon-row {
    display: flex;
    justify-content: space-around;
}

.icon {
    width: 18px; /* Set a uniform width for icons */
    height: 18px; /* Set a uniform height for icons */
    transition: transform 0.3s;
    cursor: pointer;
}

.icon:hover {
    transform: scale(1.1); /* Slightly enlarge the icon on hover */
}

.icon-item span {
    margin-top: 5px; /* Adds space between the icon and the number */
    color: rgba(0, 0, 0, 0.787); /* Change the color to ensure visibility */
    font-weight: bold; /* Makes the number stand out */
    pointer-events: none; /* Ensures the number doesn't interfere with icon hover */
}
</style>