<script setup lang="ts">
import { computed, onMounted } from "vue";

const props = defineProps<{ tweet: Tweet; }>();
const formattedTime = computed(() => {
    const date = new Date(props.tweet.timestamp);
    return date.toLocaleString();
});

onMounted(() => {
    console.log("In TweetView");
});
</script>

<template>
    <div class="card" style="width: 40rem;">
        <div class="card-header d-flex align-items-start">
            <img :src="tweet.user.avatar" alt="User Avatar" class="rounded-circle me-2" width="50"
                height="50" />
            <div>
                <h5 class="mb-0">{{ tweet.user.username }}</h5>
                <small class="text-muted">@{{ tweet.user.alias }} - {{ formattedTime }}</small>
            </div>
        </div>
        <div class="card-body">
            <p class="card-text">{{ tweet.content }}</p>
            <div v-if="tweet.media?.length" class="media-attachments">
                <img v-for="(media, index) in tweet.media" :key="index" :src="media" class="img-fluid mb-2" />
            </div>
        </div>
    </div>
</template>

<style scoped>
.media-attachments img {
    width: 100%;
}

.card {
    width: 100%
}

.card-wrapper {
    position: relative;
}
</style>