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
const forwardBy = ref()

onMounted(async () => {
    if (tweet.value.originalTweetId) {
        originTweet.value = await tweetStore.fetchTweet(tweet.value.originalTweetId, tweet.value.originalAuthorId)
        if (originTweet.value) {
            tweet.value.originalTweet = originTweet.value
            if (!tweet.value.content && !tweet.value.attachments) {
                // A retweet. Rendering original tweet in the place of tweet.
                forwardBy.value = tweet.value.author.username
                tweet.value = originTweet.value
                isRetweet.value = true
            }
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
    <div @click.prevent='openDetailView' class='card ms-1 tweet-container'>
      <div class='card-header d-flex align-items-start'>
        <ItemHeader v-if='isRetweet' :tweet='originTweet' :author='originTweet.author' :timestamp='tweet.timestamp as number'
          :is-retweet='isRetweet' :by='forwardBy'>
        </ItemHeader>
        <ItemHeader v-else :author='tweet.author' :tweet='tweet' :timestamp='tweet.timestamp as number'>
        </ItemHeader>
      </div>
  
      <div v-if='isRetweet' class='card-body'>
        <p v-if='originTweet.content' class='card-text' v-html='linkify(originTweet.content)'></p>
        <div v-if='originTweet.attachments?.length' class='media-attachments'>
          <div v-if='originTweet.attachments.length === 1' class='single-attachment'>
            <MediaView :media='originTweet.attachments[0]' :tweet='tweet' class='img-fluid portrait-center'></MediaView>
          </div>
          <div v-else class='multiple-attachments'>
            <MediaView v-for='(media, index) in originTweet.attachments.slice(0, 4)' :media='media' :tweet='tweet'
              :key='index' class='img-fluid'
              :addtional-items='index === 3 && originTweet.attachments.length > 4 ? originTweet.attachments.length-4 : undefined'>
            </MediaView>
          </div>
        </div>
        <!-- Icon row and other content -->
      </div>
  
      <div v-else class='card-body'>
        <p v-if='tweet.content' class='card-text' v-html='linkify(tweet.content)'></p>
        <div v-if='tweet.attachments?.length' class='media-attachments'>
          <div v-if='tweet.attachments.length === 1' class='single-attachment'>
            <MediaView :media='tweet.attachments[0]' :tweet='tweet' class='img-fluid portrait-center'></MediaView>
          </div>
          <div v-else class='multiple-attachments'>
            <MediaView v-for='(media, index) in tweet.attachments.slice(0, 4)' :media='media' :tweet='tweet'
              :key='index' class='img-fluid'
              :addtional-items='index === 3 && tweet.attachments.length > 4 ? tweet.attachments.length-4 : undefined'>
            </MediaView>
          </div>
        </div>
      </div>
    </div>
  </template>
  
  <style scoped>
  .tweet-container {
    overflow: hidden;
    max-height: 80vh;
  }
  
  .single-attachment {
    width: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    max-height: 50vh;
    /* Limit the height to 50% of the viewport height */
  }
  
  .media-attachments {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    position: relative;
    /* Positioning context for overlay */
  }
  
  .multiple-attachments {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    grid-template-rows: repeat(2, 1fr);
    gap: 2px;
    position: relative;
    /* Positioning context for overlay */
    counter-increment: item-counter;
    /* Add counter */
  }
  
  .multiple-attachments .img-fluid {
    width: 100%;
    height: 0;
    padding-bottom: 100%;
    /* This creates a square aspect ratio */
    object-fit: cover;
    /* Ensures the image covers the entire square */
    object-position: center;
    /* Centers the image within the square */
    display: block;
    /* Ensures the element is treated as a block-level element */
    overflow: hidden;
    /* Ensures no overflow is visible */
    position: relative;
    /* Positioning context for overlay */
  }
  
  .portrait-center {
    object-fit: contain; /* Changed from cover to contain */
    object-position: top;
    max-height: 100%; /* Ensure it doesn't exceed the container's height */
    max-width: 100%; /* Ensure it doesn't exceed the container's width */
  }
  
  .overlay {
    z-index: 9999;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    /* Semi-transparent background */
    display: flex;
    justify-content: center;
    align-items: center;
    color: white;
    font-size: 48px;
    font-weight: bold;
    pointer-events: none;
    /* Ensures the overlay doesn't interfere with clicks */
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
    padding: 4px 0px 0px 8px;
  }
  
  .card-text a {
    color: blue;
    text-decoration: underline;
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
    color: rgba(0, 0, 0, 0.819);
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
    color: rgba(0, 0, 0, 0.787);
    /* Change the color to ensure visibility */
    font-weight: bold;
    /* Makes the number stand out */
    pointer-events: none;
    /* Ensures the number doesn't interfere with icon hover */
  }
  </style>