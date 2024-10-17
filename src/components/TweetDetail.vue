<script lang="ts" setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetListStore } from '@/stores/tweetStore';
import { formatTimeDifference } from '@/lib';
import MediaView from "@/views/MediaView.vue";
import router from '@/router';

const route = useRoute();
const tweetStore = useTweetListStore()
const tweetId = route.params.tweetId as string
const authorId = route.params.authorId as string | undefined
const tweet = ref()
const countdown = ref(10); 
let countdownInterval: number | undefined;

onMounted(async () => {
    // Fetch tweet if it is not in session already.
    tweet.value = sessionStorage.getItem("tweetDetail")
    if (!tweet.value) {
        tweet.value = await tweetStore.getTweet(tweetId, authorId) as Tweet
        console.log(tweet.value)
    } else {
        tweet.value = JSON.parse(tweet.value)
    }
    await tweetStore.loadComments(tweet.value)
    
    if (!tweet.value) {
    countdownInterval = window.setInterval(() => {
      if (countdown.value > 0) {
        countdown.value--;
      } else {
        clearInterval(countdownInterval); // Clear interval when countdown reaches 0
        location.reload(); // Reload the page
      }
    }, 1000);
  }
});

onUnmounted(()=>{
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
})
</script>

<template>
    <div class="container">
        <div class="row align-items-center mb-3">
            <div class="col-lg-10 col-md-12 col-sm-12 d-flex justify-content-between">
                <div>
                    <img src="/src/tweet_icon.png" @click="router.push({name:'main'})" alt="Logo" class="rounded-circle me-2" width="60"
                    height="60"/>
                </div>
                <div class="d-flex align-items-center">
                    <button class='btn btn-primary me-2' @click="tweetStore.downloadApk">Download</button>
                    <img src="/src/tweet_QR.png" alt="QR Code" class="qr-code" />
                </div>
            </div>
        </div>
        <div class="row">
            <div class="col-lg-10 col-md-12  col-sm-12">
                <div v-if="tweet" class="tweet card mb-3">
                    <div class="card-header d-flex align-items-center">
                        <img :src="tweet.author.avatar" alt="User Avatar" class="rounded-circle me-2" >
                        <div>
                            <h5 class="mb-0">{{ tweet.author.name }}</h5>
                            <small class="text-muted">@{{ tweet.author.username }} - {{
                                formatTimeDifference(tweet.timestamp as number) }}</small>
                        </div>
                    </div>
                    <div class="card-body">
                        <p class="card-text">{{ tweet.content }}</p>
                        <div v-if="tweet.attachments?.length" class="media-attachments">
                            <MediaView v-for="(media, index) in tweet.attachments" :key="index" v-bind=media class="img-fluid mb-2"></MediaView>
                        </div>
                        <div class='icon-row d-flex justify-content-around mt-3'>
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
                <div v-else>
                    <p>Loading tweet... ({{ countdown }})</p> 
                </div>
                <div v-if="tweet" v-for="(comment, index) in tweet.comments" :key="index" class="comment card mb-0">
                    <div class="card-header d-flex align-items-center">
                        <img :src="comment.author.avatar" alt="User Avatar" class="rounded-circle me-2" width="40"
                            height="40">
                        <div>
                            <h6 class="mb-0">{{ comment.author.name }}</h6>
                            <small class="text-muted">@{{ comment.author.username }} - {{
                                formatTimeDifference(comment.timestamp as number) }}</small>
                        </div>
                    </div>
                    <div class="card-body">
                        <p class="card-text">{{ comment.content }}</p>
                        <div v-if="comment.attachments?.length" class="media-attachments">
                            <MediaView v-for="(media, index) in tweet.attachments" :key="index" v-bind=media class="img-fluid mb-2"></MediaView>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.media-attachments img {
    width: 100%;
}
.rounded-circle {
    width: 50px;
    height: 50px;
}
.qr-code {
    width: 80px;
    height: 80px;
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