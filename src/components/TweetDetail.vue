<script lang="ts" setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore } from "@/stores";
import { MediaView, DetailHeader, ItemHeader, TweetView } from "@/views";

const route = useRoute();
const tweetStore = useTweetStore()
const tweetId = computed(()=>route.params.tweetId as MimeiId)
const authorId = computed(()=>route.params.authorId as MimeiId | undefined)
const tweet = ref()
const originTweet = ref()
const isRetweet = ref(false)
const isLoading = ref(false)
const author = ref<User>();

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
};

const formattedTitle = computed(() => {
    let title = tweet.value.title
    if (title)
        return title
    title = ""
    if (!tweetStore.isEmptyString(tweet.value.content)) {
        title = tweet.value.content!.substring(0, 20)
    } else {
        if (tweet.value.originalTweetId) {
            if (!tweetStore.isEmptyString(tweet.value.originalTweet.content)) {
                title = tweet.value.originalTweet!.content!.substring(0, 20)
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
    if (newValue && oldValue !== newValue) {
        let t = await tweetStore.getTweet(newValue, authorId.value)
        if (t) {
            console.log(t)
            tweet.value = t
            sessionStorage.setItem("tweetDetail", JSON.stringify(tweet.value))
            showTweet()
            // router.push(`/tweet/${tweetId.value}/${authorId.value}`)
        }
    }
});

function linkify(text: string) {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}
</script>

<template>
    <div v-if="tweet" class="card mb-1">
        <div class="card-header d-flex align-items-center">
            <DetailHeader v-if="isRetweet" :author="tweet.originalTweet.author" :timestamp="tweet.timestamp"
                :is-retweet="isRetweet" :by="tweet.author?.username">
            </DetailHeader>
            <DetailHeader v-else :author="tweet.author" :timestamp="tweet.timestamp"></DetailHeader>
        </div>
        <div v-if="isRetweet" class="card-body" id="content">

            <p v-if="originTweet.content" class="card-text" v-html="linkify(originTweet.content)"></p>

            <div v-if="originTweet.attachments?.length" class="media-attachments">
                <MediaView v-for="(media, index) in originTweet.attachments" :key="index" :media=media
                    :autoplay="index==0" class="img-fluid mb-1"></MediaView>
            </div>
            <div class='icon-row d-flex justify-content-around mt-1 mb-2'>
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
            <p v-if="tweet.content" class="card-text" v-html="linkify(tweet.content)"></p>

            <div v-if="tweet.attachments?.length" class="media-attachments">
                <MediaView v-for="(media, index) in tweet.attachments" :key="index" :media=media
                    :autoplay="index==0" class="img-fluid">
                </MediaView>
            </div>

            <!-- quoted tweet -->
            <blockquote v-if="!isRetweet">
                <TweetView v-if="originTweet" :tweet="originTweet" :is-quoted=true></TweetView>
            </blockquote>

            <div class='icon-row d-flex justify-content-around mt-1 mb-2'>
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
        <!-- Show comments of the original tweet if it is a retweet -->
        <div v-if="isRetweet" v-for="(comment, index) in originTweet.comments" :key="index" class="comment card mb-1 mt-3">
            <div class="card-header d-flex align-items-center">
                <ItemHeader :author="comment.author" :tweet="comment" :timestamp="comment.timestamp"></ItemHeader>
            </div>
            <div class="card-body">

                <p class="card-text">{{ comment.content }}</p>

                <div v-if="comment.attachments?.length" class="media-attachments">
                    <MediaView v-for="(media, index) in comment.attachments" :key="index" v-bind=media
                        :autoplay="index==0" class="img-fluid"></MediaView>
                </div>

                <div class='icon-row d-flex justify-content-around mt-1 mb-2'>
                    <div class='icon-item d-flex align-items-center'>
                        <img src='/src/ic_heart.png' alt='Favorite' class='icon' />
                        <span class='icon-number'>{{ comment.likeCount > 0 ? comment.likeCount : null }}</span>
                    </div>
                    <div class='icon-item d-flex align-items-center'>
                        <img src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                        <span class='icon-number'>{{ comment.bookmarkCount > 0 ? comment.bookmarkCount : null }}</span>
                    </div>
                    <div class='icon-item d-flex align-items-center'>
                        <img src='/src/ic_notice.png' alt='Forward' class='icon' />
                        <span class='icon-number'>{{ comment.commentCount > 0 ? comment.commentCount : null }}</span>
                    </div>
                </div>
            </div>
        </div>
        <!-- Show comments of the tweet -->
        <div v-else v-for="(comment, index1) in tweet.comments" :key="index1" class="comment card mb-1 mt-3">
            <div class="card-header d-flex align-items-center">
                <ItemHeader :author="comment.author" :tweet="comment" :timestamp="comment.timestamp"></ItemHeader>
            </div>
            <div class="card-body">
                <p class="card-text">{{ comment.content }}</p>
                <div v-if="comment.attachments?.length" class="media-attachments">
                    <MediaView v-for="(media, index) in comment.attachments" :key="index" v-bind=media
                        :autoplay="index==0" class="img-fluid mb-2"></MediaView>
                </div>

                <div class='icon-row d-flex justify-content-around mt-1 mb-2'>
                    <div class='icon-item d-flex align-items-center'>
                        <img src='/src/ic_heart.png' alt='Favorite' class='icon' />
                        <span class='icon-number'>{{ comment.likeCount > 0 ? comment.likeCount : null }}</span>
                    </div>
                    <div class='icon-item d-flex align-items-center'>
                        <img src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                        <span class='icon-number'>{{ comment.bookmarkCount > 0 ? comment.bookmarkCount : null }}</span>
                    </div>
                    <div class='icon-item d-flex align-items-center'>
                        <img src='/src/ic_notice.png' alt='Forward' class='icon' />
                        <span class='icon-number'>{{ comment.commentCount > 0 ? comment.commentCount : null }}</span>
                    </div>
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