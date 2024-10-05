<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetListStore } from '@/stores/tweetStore';

const route = useRoute();
const tweetStore = useTweetListStore()
const tweetId = route.params.tweetId as string
const tweet = ref()
const comments = ref<Tweet[]>([])

onMounted(async ()=> {
    // Fetch tweets or perform any necessary setup
    tweet.value = sessionStorage.getItem("tweetDetail")
    if (!tweet.value) {
        tweet.value = await tweetStore.getTweet(tweetId) as Tweet
    } else {
        tweet.value = JSON.parse(tweet.value)
    }
    comments.value = tweet.value.comments
});
function loadComments() {

}
function formattedTime(t: number){
    const date = new Date(t);
    return date.toLocaleString();
}
</script>

<template>
    <div class="container mt-5">
        <div class="row justify-content-center">
            <div class="col-md-8">
                <div v-if="tweet" class="tweet card mb-3">
                    <div class="card-header d-flex align-items-center">
                        <img :src="tweet.author.avatar" alt="User Avatar" class="rounded-circle me-2" width="50"
                            height="50">
                        <div>
                            <h5 class="mb-0">{{ tweet.author.username }}</h5>
                            <small class="text-muted">@{{ tweet.author.alias }} - {{ formattedTime(tweet.timestamp as number) }}</small>
                        </div>
                    </div>
                    <div class="card-body">
                        <p class="card-text">{{ tweet.content }}</p>
                        <div v-if="tweet.attachments?.length" class="media-attachments">
                            <img v-for="(media, index) in tweet.attachments" :key="index" :src="media"
                                class="img-fluid mb-2" />
                        </div>
                    </div>
                </div>
                <div v-else>
                    <p>Loading tweet...</p>
                </div>
                <div v-for="(comment, index) in tweet.commetns" :key="index"  class="comment card mb-3">
                    <div class="card-header d-flex align-items-center">
                        <img :src="comment.author.avatar" alt="User Avatar" class="rounded-circle me-2" width="50"
                            height="50">
                        <div>
                            <h5 class="mb-0">{{ comment.author.username }}</h5>
                            <small class="text-muted">@{{ comment.author.alias }} - {{ formattedTime(comment.timestamp as number) }}</small>
                        </div>
                    </div>
                    <div class="card-body">
                        <p class="card-text">{{ comment.content }}</p>
                        <div v-if="comment.attachments?.length" class="media-attachments">
                            <img v-for="(media, index) in comment.attachments" :key="index" :src="media"
                                class="img-fluid mb-2" />
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
</style>