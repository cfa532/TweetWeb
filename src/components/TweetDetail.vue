<script lang="ts" setup>
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore, type Tweet, type User } from '@/stores/tweetStore';

const route = useRoute();
const tweetStore = useTweetStore();
const tweet = computed(()=> {
    const { userId, tweetId } = route.params;
    return tweetStore.fetchTweet(userId as string, tweetId as string);
});

const formattedTime = computed(()=> {
    if (tweet.value) {
        const date = new Date(tweet.value.timestamp);
        return date.toLocaleString();
    }
    return '';
})
onMounted(()=> {
    // Fetch tweets or perform any necessary setup
});
</script>

<template>
    <div class="container mt-5">
        <div class="row justify-content-center">
            <div class="col-md-8">
                <div v-if="tweet" class="tweet card mb-3">
                    <div class="card-header d-flex align-items-center">
                        <img :src="tweet.user.avatar" alt="User Avatar" class="rounded-circle me-2" width="50"
                            height="50">
                        <div>
                            <h5 class="mb-0">{{ tweet.user.username }}</h5>
                            <small class="text-muted">@{{ tweet.user.alias }} - {{ formattedTime }}</small>
                        </div>
                    </div>
                    <div class="card-body">
                        <p class="card-text">{{ tweet.content }}</p>
                        <div v-if="tweet.media.length" class="media-attachments">
                            <img v-for="(media, index) in tweet.media" :key="index" :src="media"
                                class="img-fluid mb-2" />
                        </div>
                    </div>
                </div>
                <div v-else>
                    <p>Loading tweet...</p>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.media-attachments img {
    width: 100%;
    max-width: 300px;
}
</style>