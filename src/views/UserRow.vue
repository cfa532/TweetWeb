<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';

const props = defineProps({ 
    userId: {type: String as PropType<MimeiId>, required: true},
    showDetail: {type: Boolean, required: false, default: true},
})
const router = useRouter()
const tweetStore = useTweetStore()
const user = ref<User | null>(null)
const isLoading = ref(true)

// Fetch user data when component mounts, with a short timeout to avoid blocking
onMounted(async () => {
    try {
        const userData = await Promise.race([
            tweetStore.getUser(props.userId),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000))
        ])
        user.value = userData || null
    } catch (error) {
        console.error('Failed to load user:', error)
    } finally {
        isLoading.value = false
    }
})

function openUserPage(userId: string) {
    useTweetStore().addFollowing(userId)
    router.push(`/author/${userId}`)
}
</script>
<template>
  <!-- Loading state -->
  <div v-if="isLoading" class="tweet-header d-flex align-items-start">
    <div class="avatar me-2">
      <div class="rounded-circle bg-light" style="width: 40px; height: 40px;"></div>
    </div>
    <div class="user-info flex-grow-1">
      <div class="username-alias-time">
        <div class="bg-light rounded" style="height: 16px; width: 120px; margin-bottom: 4px;"></div>
        <div class="bg-light rounded" style="height: 14px; width: 80px;"></div>
      </div>
    </div>
  </div>

  <!-- User data loaded -->
  <div v-else-if="user" class="tweet-header d-flex align-items-start" @click.stop="openUserPage(user.mid)">
    <!-- User Avatar -->
    <div class="avatar me-2">
      <img :src="user.avatar" alt="User Avatar" class="rounded-circle">
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

  <!-- Error state -->
  <div v-else class="tweet-header d-flex align-items-start">
    <div class="user-info flex-grow-1">
      <span class="text-muted">Failed to load user</span>
    </div>
  </div>
</template>
<style>
.tweet-header {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.avatar {
  display: flex;
  align-items: center;
}

.avatar img {
  object-fit: cover;
  width: 40px;
  height: 40px;
  cursor: pointer;
}
.text-muted {
  font-size: 0.9rem;
}
.user-info {
  line-height: 1.2;
  flex-grow: 1;
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