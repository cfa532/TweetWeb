<script setup>
import { useTweetStore, type Tweet, type User } from "@/stores/tweetStore";

const tweet = defineProps < { tweet: Tweet } > (); // Typed props
const formattedTime = computed(() => {
    const date = new Date(tweet.tweet.timestamp);
    return date.toLocaleString();
});

// No need for setup function anymore, directly access props and computed properties
</script>

<template>
    <div class="tweet card mb-3">
        <div class="card-header d-flex align-items-center">
            <img :src="tweet.user.avatar" alt="User Avatar" class="rounded-circle me-2" width="50" height="50">
            <div>
                <h5 class="mb-0">{{ tweet.user.username }}</h5>
                <small class="text-muted">@{{ tweet.user.alias }} - {{ formattedTime }}</small>
            </div>
        </div>
        <div class="card-body">
            <p class="card-text">{{ tweet.content }}</p>
            <div v-if="tweet.media.length" class="media-attachments">
                <img v-for="(media, index) in tweet.media" :key="index" :src="media" class="img-fluid mb-2" />
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