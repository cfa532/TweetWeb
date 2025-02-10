<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { MediaView, ItemHeader } from "@/views";
import { useTweetStore } from "@/stores";

const tweetStore = useTweetStore()
const router = useRouter()

const props = defineProps({
    tweet: { type: Object as PropType<Tweet>, required: true },
    isQuoted: { type: Boolean, required: false, default: false }
});

const originalTweet = ref<Tweet | null>();
const isRetweet = ref(false);
const forwardBy = ref<string | undefined>(undefined);

const currentTweet = ref(props.tweet);

onMounted(async () => {
    if (currentTweet.value.originalTweetId) {
        originalTweet.value = await tweetStore.fetchTweet(
            currentTweet.value.originalTweetId,
            currentTweet.value.originalAuthorId
        );

        if (originalTweet.value) {
            if (!currentTweet.value.content && !currentTweet.value.attachments) {
                // A retweet.
                forwardBy.value = currentTweet.value.author.username;
                isRetweet.value = true;
            }
        }
    }
});

const displayTweet = computed(() => {
    return isRetweet.value && originalTweet.value ? originalTweet.value : currentTweet.value;
});

function openDetailView() {
    sessionStorage.setItem("tweetDetail", JSON.stringify(displayTweet.value));
    router.push(`/tweet/${displayTweet.value.mid}/${displayTweet.value.author.mid}`);
}

function linkify(text: string) {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}
</script>

<template>
    <div @click.prevent='openDetailView' class='card ms-1 tweet-container'>
        <div class='card-header d-flex align-items-start'>
            <ItemHeader
                :tweet="originalTweet"
                :author="originalTweet?.author"
                :timestamp="displayTweet.timestamp as number"
                :is-retweet="isRetweet"
                :by="forwardBy"
                v-if="isRetweet && originalTweet"
            />
            <ItemHeader
                v-else
                :tweet="displayTweet"
                :author="displayTweet.author"
                :timestamp="displayTweet.timestamp as number"
            />
        </div>

        <div class='card-body'>
            <p v-if='displayTweet.content' class='card-text' v-html='linkify(displayTweet.content)'></p>
            <div v-if='displayTweet.attachments?.length' class='media-attachments'>
                <div v-if='displayTweet.attachments.length === 1' class='single-attachment'>
                    <MediaView :media='displayTweet.attachments[0]' :tweet='displayTweet' class='img-fluid portrait-center'></MediaView>
                </div>
                <div v-else class='multiple-attachments'>
                    <MediaView
                        v-for='(media, index) in displayTweet.attachments.slice(0, 4)'
                        :media='media'
                        :tweet='displayTweet'
                        :key='index'
                        class='img-fluid'
                        :addtional-items='index === 3 && displayTweet.attachments.length > 4 ? displayTweet.attachments.length - 4 : undefined'
                    ></MediaView>
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
}

.media-attachments {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    position: relative;
}

.multiple-attachments {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    grid-template-rows: repeat(2, 1fr);
    gap: 2px;
    position: relative;
    counter-increment: item-counter;
}

.multiple-attachments .img-fluid {
    width: 100%;
    height: 0;
    padding-bottom: 100%;
    object-fit: cover;
    object-position: center;
    display: block;
    overflow: hidden;
    position: relative;
}

.portrait-center {
    object-fit: contain;
    object-position: top;
    max-height: 100%;
    max-width: 100%;
}

.overlay {
    z-index: 9999;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    color: white;
    font-size: 48px;
    font-weight: bold;
    pointer-events: none;
}

.card {
    width: 100%;
    margin: 0 0 15px 0;
}

.card-header {
    margin: 0;
    padding: 0 8px;
    cursor: pointer;
}

.card-body {
    margin: 0;
    padding: 0;
}

.card-text {
    text-align: left;
    font-size: medium;
    white-space: pre-wrap;
    padding: 4px 0 0 8px;
}

.card-text a {
    color: blue;
    text-decoration: underline;
}

.icon-item {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
}

.icon-number {
    position: absolute;
    bottom: -1px;
    right: -15px;
    font-size: 15px;
    color: rgba(0, 0, 0, 0.819);
}

.icon-row {
    display: flex;
    justify-content: space-around;
}

.icon {
    width: 18px;
    height: 18px;
    transition: transform 0.3s;
    cursor: pointer;
}

.icon:hover {
    transform: scale(1.1);
}

.icon-item span {
    margin-top: 5px;
    color: rgba(0, 0, 0, 0.787);
    font-weight: bold;
    pointer-events: none;
}
</style>