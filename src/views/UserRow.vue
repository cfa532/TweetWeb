<script setup lang="ts">
import { onMounted, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';

const props = defineProps({ 
    user: {type: Object as PropType<User>, required: true},
    showDetail: {type: Boolean, required: false, default: true},
})
const router = useRouter()
const avatar = computed(()=>{
    let url = "http://" + props.user.providerIp
    let mid = props.user.avatar
    if (mid)
        return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
})

onMounted(()=>{
})
function openUserPage(userId: string) {
    useTweetStore().addFollowing(userId)
    router.push(`/author/${userId}`)
}
</script>
<template>
  <div class="tweet-header d-flex align-items-start">
    <!-- User Avatar -->
    <div class="avatar me-2">
      <img :src="avatar" alt="User Avatar" class="rounded-circle" @click.stop="openUserPage(user.mid)">
    </div>

    <!-- User Info -->
    <div class="user-info flex-grow-1">
      <!-- Username, Alias, and Time -->
      <div class="username-alias-time">
        <span class="username fw-bold">{{ user.name }}</span>
        <span class="alias text-muted">@{{ user.username }}</span>
        <span class="time text-muted">- {{ formatTimeDifference(user.timestamp as number) }}</span>
      </div>

      <!-- Followers and Friends Links -->
      <div v-if="showDetail" class="links mt-1">
        <span class="alias text-muted">{{ user.profile }}</span>
      </div>
    </div>
  </div>
</template>
<style>
.tweet-header {
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
  line-height: 1.2;
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