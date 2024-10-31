<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from 'vue-router';
import { MediaView, ItemHeader } from "@/views";

const router = useRouter()
const props = defineProps<{ tweet: Tweet; }>();

onMounted(() => {
});
function openDetailView() {
    // Route to the tweet detail page using the tweet ID
    console.log("open detail view")
    sessionStorage.setItem("tweetDetail", JSON.stringify(props.tweet))
    router.push(`/tweet/${props.tweet.mid}`);
};
</script>

<template>
    <div class="card" @click.prevent="openDetailView">
        <div class="card-header d-flex align-items-start">
            <ItemHeader :tweet="tweet"></ItemHeader>
        </div>
        <div class="card-body">
            <p class="card-text">{{ tweet.content }}</p>
            <div v-if="tweet.attachments?.length" class="media-attachments">
                <MediaView v-for="(media, index) in tweet.attachments" :key="index"
                    v-bind=media class="img-fluid mb-2"></MediaView>
            </div>
            <div class='icon-row d-flex justify-content-around mt-3'>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_heart.png' alt='Favorite' class='icon' />
                    <span class='icon-number'>{{ tweet.likeCount! > 0 ? tweet.likeCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_bookmark.png' alt='Bookmark' class='icon' />
                    <span class='icon-number'>{{ tweet.bookmarkCount! > 0 ? tweet.bookmarkCount : null }}</span>
                </div>
                <div class='icon-item d-flex align-items-center'>
                    <img src='/src/ic_notice.png' alt='Forward' class='icon' />
                    <span class='icon-number'>{{ tweet.commentCount! > 0 ? tweet.commentCount : null }}</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.media-attachments img {
    width: 100%;
}

.card {
    width: 100%;
    margin: 0px 0px 15px 0px;
}
.card-header {
    margin: 0px;
    padding: auto;
    cursor: pointer;
}
.card-body {
    margin: 0px;
    padding: auto;
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