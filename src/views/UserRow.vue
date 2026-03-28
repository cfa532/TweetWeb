<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';
import { useAlertStore } from '@/stores/alert.store';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps({ 
    userId: {type: String as PropType<MimeiId>, required: true},
    showDetail: {type: Boolean, required: false, default: true},
    showFollowButton: {type: Boolean, required: false, default: false},
    isFollowing: {type: Boolean, required: false, default: false},
})
const emit = defineEmits<{
  (e: 'follow-toggled', payload: { userId: MimeiId; isFollowing: boolean }): void
  (e: 'resolve-failed', userId: MimeiId): void
}>()
const router = useRouter()
const tweetStore = useTweetStore()
const alertStore = useAlertStore()
const user = ref<User | null>(null)
const isLoading = ref(true)
const localIsFollowing = ref(false)
const isTogglingFollow = ref(false)

const canShowFollowButton = computed(() => {
  return props.showFollowButton &&
    !!tweetStore.loginUser &&
    !!user.value &&
    user.value.mid !== tweetStore.loginUser.mid
})

// Show cached data immediately if available, otherwise load from server
const cachedUser = tweetStore.users.get(props.userId) ||
    (tweetStore.loginUser?.mid === props.userId ? tweetStore.loginUser : null)
if (cachedUser) {
    user.value = cachedUser
    isLoading.value = false
}

watch(() => props.isFollowing, (value) => {
    localIsFollowing.value = value
}, { immediate: true })

onMounted(async () => {
    if (user.value) return // Already have cached data
    try {
        const userData = await Promise.race([
            tweetStore.getUser(props.userId),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15000))
        ])
        user.value = userData || null
    } catch (error) {
        console.error('Failed to load user:', error)
    } finally {
        isLoading.value = false
        if (!user.value) {
            emit('resolve-failed', props.userId)
        }
    }
})

function openUserPage(userId: string) {
    useTweetStore().addFollowing(userId)
    router.push(`/author/${userId}`)
}

async function onToggleFollow(event: Event) {
    event.stopPropagation()
    if (!user.value || !tweetStore.loginUser || isTogglingFollow.value) return

    const previous = localIsFollowing.value
    localIsFollowing.value = !previous
    isTogglingFollow.value = true

    try {
        const nextState = await tweetStore.toggleFollowing(user.value.mid)
        localIsFollowing.value = nextState
        emit('follow-toggled', { userId: user.value.mid, isFollowing: nextState })
    } catch (error) {
        localIsFollowing.value = previous
        console.error('Failed to toggle following:', error)
        alertStore.error(t('profile.followActionFailed'))
    } finally {
        isTogglingFollow.value = false
    }
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
    <button
      v-if="canShowFollowButton"
      class="follow-btn"
      :class="{ 'is-following': localIsFollowing }"
      :disabled="isTogglingFollow"
      @click.stop="onToggleFollow"
    >
      {{ localIsFollowing ? $t('profile.unfollow') : $t('profile.follow') }}
    </button>
  </div>

  <!-- Unresolved users are removed by the parent via @resolve-failed -->
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

.follow-btn {
  border: 1px solid #0d6efd;
  border-radius: 999px;
  background: transparent;
  color: #0d6efd;
  font-size: 0.9rem;
  font-weight: 500;
  min-width: 92px;
  padding: 6px 14px;
  line-height: 1;
  transition: all 0.2s ease;
}

.follow-btn.is-following {
  border-color: #dc3545;
  color: #dc3545;
}

.follow-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
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