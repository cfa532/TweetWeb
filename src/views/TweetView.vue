<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';

const router = useRouter()
const props = defineProps<{ tweet: Tweet; }>();

onMounted(() => {
    console.log("In TweetView");
});
function openDetailView() {
  // Route to the tweet detail page using the tweet ID
  console.log("open detail view")
  sessionStorage.setItem("tweetDetail", JSON.stringify(props.tweet))
  router.push(`/tweet/${props.tweet.mid}`);
};
</script>

<template>
    <div class="card" @click="openDetailView">
        <div class="card-header d-flex align-items-start">
            <img :src="tweet.author.avatar" alt="User Avatar" class="rounded-circle me-2" width="50"
                height="50" />
            <div>
                <h5 class="mb-0">{{ tweet.author.name }}</h5>
                <small class="text-muted">@{{ tweet.author.username }} - {{ formatTimeDifference(tweet.timestamp as number) }}</small>
            </div>
        </div>
        <div class="card-body">
            <p class="card-text">{{ tweet.content }}</p>
            <div v-if="tweet.attachments?.length" class="media-attachments">
                <img v-for="(media, index) in tweet.attachments" :key="index" :src="media" class="img-fluid mb-2" />
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
    margin-bottom: 15px;
}

.card-wrapper {
    position: relative;
}
</style>