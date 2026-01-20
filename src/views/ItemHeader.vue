<script setup lang="ts">
import { onMounted, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';
import { CornerMenu } from '@/views';

const props = defineProps({
    author: {type: Object as PropType<User | null>, required: false},
    timestamp: {type: Number, required: false },
    isRetweet: {type: Boolean, required: false, default: false},
    by: {type: String, required: false},
    tweet: {type: Object as PropType<Tweet>, required: false},
    actualTweet: {type: Object as PropType<Tweet>, required: false}, // The actual tweet to delete (for retweets, this is the retweet wrapper)
    parentTweet: {type: Object as PropType<Tweet>, required: false},
    isComment: {type: Boolean, required: false, default: false}
})
const router = useRouter()
const tweetStore = useTweetStore()

function openUserPage(userId: string) {
  tweetStore.addFollowing(userId)
    router.push(`/author/${userId}`)
}
function openDetailView() {
    sessionStorage.setItem("tweetDetail", JSON.stringify(props.tweet))
    /**
     * Try to open a comment as Tweet detail page. The comment is stored with the tweet,
     * so it cannot be find by the authorId of the comment. Have to seach for the commentId (tweetId)
    */
    router.push(`/tweet/${props.tweet?.mid}`);
};

</script>

<template>
  <div v-if='author' class='tweet-header d-flex'>
    <!-- User Avatar -->
    <div class='avatar me-2'>
      <img :src='author.avatar' alt='User Avatar' class='rounded-circle' @click.stop='openUserPage(author.mid)'>
    </div>
    <!-- User Info -->
    <div class='user-info flex-grow-1' @click.prevent='openDetailView'>
      <!-- Optional Label -->
      <div v-if='isRetweet' class='label text-muted small'>
        Forwarded by @{{ by }}
      </div>
      <!-- Username, Alias, and Time -->
      <div class='username-alias-time'>
        <span class='username fw-bold'>{{ author.name }}</span>
      </div>
      <!-- Followers and Friends Links -->
      <div class='mt-1'>
        <span class='alias text-muted'>@{{ author.username }}</span>
        <span v-if='props.timestamp' class='time text-muted'> - {{ formatTimeDifference(props.timestamp as number)
          }}</span>
      </div>
    </div>
  </div>
  <!-- Loading placeholder when author is not yet loaded -->
  <div v-else class='tweet-header d-flex'>
    <div class='avatar me-2'>
      <div class='rounded-circle loading-avatar'></div>
    </div>
    <div class='user-info flex-grow-1'>
      <div class='username-alias-time'>
        <span class='username fw-bold loading-text'>Loading...</span>
      </div>
      <div class='mt-1'>
        <span class='alias text-muted loading-text'>@loading</span>
        <span v-if='props.timestamp' class='time text-muted'> - {{ formatTimeDifference(props.timestamp as number) }}</span>
      </div>
    </div>
  </div>
  <div class='tweet-title-container'>
    <div class='tweet-title' @click.prevent='openDetailView'>
      {{ tweet?.title }}
    </div>
  </div>
  <div class='corner-menu-container'>
    <CornerMenu :tweet="actualTweet || tweet" :parent-tweet="parentTweet" :is-comment="isComment" />
  </div>
</template>

<style>
.tweet-title {
  font-size: 0.9rem; /* Adjust the size as needed */
  cursor: pointer;
  white-space: nowrap; /* Prevent text from wrapping */
  overflow: hidden;       /* Hide overflowing text */
  text-overflow: ellipsis; /* Add ellipsis (...) for overflow */
}

.tweet-title-container {
  display: flex;
  justify-content: flex-end; /* Align to the right */
  width: 60%;
  margin: 4px 0 8px 0;
}
.username {
  font-size: 0.9rem; /* Adjust the size as needed */
}
.alias {
  font-size: 0.9rem; /* Adjust the size as needed */
}
.tweet-header {
  width: 100%;
  cursor: pointer;
  margin: 8px 0 8px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  align-items: stretch;
}
.corner-menu-container {
  height: 100%;
  display: flex;
}

.avatar {
  display: flex;
  align-items: center;
}

.loading-avatar {
  width: 40px;
  height: 40px;
  background: #e9ecef;
  animation: pulse 1.5s ease-in-out infinite;
}

.loading-text {
  background: #e9ecef;
  color: transparent;
  border-radius: 4px;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
.avatar img {
  object-fit: cover;
  width: 40px;
  height: 40px;
  cursor: pointer;
}
.user-info {
  width: 100%;
  font-size: 0.8rem;
  flex-grow: 1; /* Allows the user info to take up remaining space */
}
.username-alias-time {
  display: flex;
  align-items: center;
  gap: 5px;
}
.links a {
  color: #3d5563;
  text-decoration: none;
  font-size: 0.9rem;
}
.links a:hover {
  text-decoration: underline;
}
</style>