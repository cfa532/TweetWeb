<script setup lang="ts">
import { computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter, useRoute } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';
import { useI18n } from 'vue-i18n';
import { CornerMenu } from '@/views';

const { t } = useI18n();

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
const route = useRoute()
const tweetStore = useTweetStore()

/** Bold line in tweet header: use username when display name is missing (same idea as UserAccount profile). */
const authorDisplayName = computed(() => {
  if (!props.author) return t('tweet.loadingAuthor')
  const name = props.author.name
  if (name != null && String(name).trim() !== '') return name
  const u = props.author.username
  if (u != null && String(u).trim() !== '') return u
  return t('tweet.loadingAuthor')
})

function openUserPage(userId: string) {
  if (props.author) {
    tweetStore.addFollowing(userId)
    router.push(`/author/${userId}`)
  }
}
function openDetailView() {
    sessionStorage.setItem("tweetDetail", JSON.stringify(props.tweet))
    const authorId = props.tweet?.author?.mid || props.tweet?.authorId;
    const basePath = `/tweet/${props.tweet?.mid}${authorId ? '/' + authorId : ''}`;

    if (props.isComment) {
      const parentTweetId = props.parentTweet?.mid;
      const parentAuthorId = props.parentTweet?.author?.mid;

      if (!parentTweetId) {
        // Fallback to current detail route when parent tweet prop is unavailable
        const fallbackParentId = route.params.tweetId as string;
        const fallbackAuthorId = route.params.authorId as string | undefined;
        const navigationMeta = {
          fromComment: true,
          parentTweetId: fallbackParentId,
          parentAuthorId: fallbackAuthorId,
        };
        sessionStorage.setItem('navigationMeta', JSON.stringify(navigationMeta));
        const queryParams = new URLSearchParams({
          fromComment: 'true',
          parentTweetId: fallbackParentId,
          ...(fallbackAuthorId && { parentAuthorId: fallbackAuthorId }),
        });
        router.push(`${basePath}?${queryParams.toString()}`);
      } else {
        const navigationMeta = {
          fromComment: true,
          parentTweetId: parentTweetId,
          parentAuthorId: parentAuthorId,
        };
        sessionStorage.setItem('navigationMeta', JSON.stringify(navigationMeta));
        const queryParams = new URLSearchParams({
          fromComment: 'true',
          parentTweetId: parentTweetId,
          ...(parentAuthorId && { parentAuthorId }),
        });
        router.push(`${basePath}?${queryParams.toString()}`);
      }
      return;
    }

    // Clear comment-navigation metadata for regular tweet navigation
    sessionStorage.removeItem('navigationMeta');
    router.push(basePath);
};

</script>

<template>
  <div class='tweet-header d-flex'>
    <!-- User Avatar -->
    <div :class="['avatar', 'me-2', 'author-avatar', { 'comment-avatar': isComment }]">
      <img v-if='props.author' :src='props.author.avatar' alt='User Avatar' class='rounded-circle' @click.stop='openUserPage(props.author.mid)'>
      <div v-else class='rounded-circle loading-avatar'></div>
    </div>
    <!-- User Info -->
    <div class='user-info flex-grow-1' @click.stop.prevent='openDetailView'>
      <!-- Optional Label -->
      <div v-if='isRetweet' class='label text-muted small'>
        {{ by === tweetStore.loginUser?.username ? $t('tweet.forwardedByYou') : $t('tweet.forwardedBy', { name: by }) }}
      </div>
      <!-- Username, Alias, and Time -->
      <div class='username-alias-time'>
        <span class='username fw-bold' :class='{ "loading-text": !props.author }'>{{ authorDisplayName }}</span>
      </div>
      <!-- Followers and Friends Links -->
      <div class='mt-1'>
        <span class='alias text-muted' :class='{ "loading-text": !props.author }'>@{{ props.author?.username || $t('tweet.loadingUsername') }}</span>
        <span v-if='props.timestamp' class='time text-muted'> - {{ formatTimeDifference(props.timestamp as number)
          }}</span>
      </div>
    </div>
  </div>
  <div class='tweet-title-container'>
    <div class='tweet-title' @click.stop.prevent='openDetailView'>
      {{ tweet?.title }}
    </div>
  </div>
  <div v-if="tweet" class="corner-menu-container" @click.stop>
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
  margin: 4px 0 4px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  align-items: stretch;
}
.corner-menu-container {
  height: 100%;
  display: flex;
  /* Above flex siblings so mobile hit-testing targets the menu, not the card header */
  position: relative;
  z-index: 2;
}

.avatar {
  display: flex;
  align-items: center;
}

.loading-avatar, .author-avatar .loading-avatar {
  width: 44px !important;
  height: 44px !important;
  max-width: none !important;
  max-height: none !important;
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
.avatar img, .author-avatar img {
  object-fit: cover;
  width: 44px !important;
  height: 44px !important;
  max-width: none !important;
  max-height: none !important;
  cursor: pointer;
}
.comment-avatar img {
  width: 40px !important;
  height: 40px !important;
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