<script setup lang="ts">
import { onMounted, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';

const props = defineProps({ 
    author: {type: Object as PropType<User>, required: true},
    timestamp: {type: Number, required: false },
    isRetweet: {type: Boolean, required: false, default: false},
    by: {type: String, required: false},
    tweet: {type: Object as PropType<Tweet>, required: false}
})
const router = useRouter()
const avatar = computed(()=>{
    let url = "http://" + props.author.providerIp
    let mid = props.author.avatar
    if (mid)
        return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
})

onMounted(()=>{
})
function openUserPage(userId: string) {
    useTweetStore().addFollowing(userId)
    router.push(`/author/${userId}`)
}
function openDetailView() {
    // Route to the tweet detail page using the tweet ID
    sessionStorage.setItem("tweetDetail", JSON.stringify(props.tweet))
    router.push(`/tweet/${props.tweet?.mid}/${props.author.mid}`);
};
</script>
<template>
  <div class="tweet-header d-flex align-items-start" @click.prevent="openDetailView">
    <!-- User Avatar -->
    <div class="avatar me-2">
      <img :src="avatar" alt="User Avatar" class="rounded-circle" @click.stop="openUserPage(author.mid)">
    </div>

    <!-- User Info -->
    <div class="user-info flex-grow-1">
      <!-- Optional Label -->
      <div v-if="isRetweet" class="label text-muted small">
        Forwarded by @{{ by }}
      </div>

      <!-- Username, Alias, and Time -->
      <div class="username-alias-time">
        <span class="username fw-bold">{{ author.name }}</span>
      </div>

      <!-- Followers and Friends Links -->
      <div class="mt-1">
        <span class="alias text-muted">@{{ author.username }}</span>
        <span v-if="props.timestamp" class="time text-muted"> - {{ formatTimeDifference(props.timestamp as number) }}</span>
      </div>
    </div>
  </div>
</template>
<style>
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
  align-items: center; /* Vertically centers the content within the header */
}
.avatar {
  display: flex;
  align-items: center; /* Ensures the avatar is vertically centered */
}
.avatar img {
  object-fit: cover;
  width: 40px;
  height: 40px;
  cursor: pointer;
}
.user-info {
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