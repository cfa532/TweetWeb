<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PropType } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';

const router = useRouter();
const { t } = useI18n();
const tweetStore = useTweetStore();
const showShareMenu = ref(false);
const copied = ref(false);

const props = defineProps({
  tweet: { type: Object as PropType<Tweet>, required: true },
});

const emit = defineEmits<{
  (e: 'updated', tweet: Tweet): void;
}>();

const isLiked = computed(() => (props.tweet.likeCount ?? 0) > 0 && tweetStore.loginUser != null);
const isBookmarked = computed(() => (props.tweet.bookmarkCount ?? 0) > 0 && tweetStore.loginUser != null);

function formatCount(count?: number): string {
  if (!count || count <= 0) return '';
  if (count < 1000) return count.toString();
  if (count < 10000) {
    const k = count / 1000;
    return k % 1 === 0 ? `${Math.floor(k)}k` : `${k.toFixed(1)}k`;
  }
  if (count < 1000000) return `${Math.floor(count / 1000)}k`;
  if (count < 10000000) {
    const m = count / 1000000;
    return m % 1 === 0 ? `${Math.floor(m)}M` : `${m.toFixed(1)}M`;
  }
  return `${Math.floor(count / 1000000)}M`;
}

function onComment() {
  router.push({ name: 'post', params: { tweetId: props.tweet.mid } });
}

async function onRetweet() {
  if (!tweetStore.loginUser) {
    router.push({ name: 'login' });
    return;
  }
  router.push({ name: 'post', query: { retweet: props.tweet.mid } });
}

async function onLike() {
  if (!tweetStore.loginUser) {
    router.push({ name: 'login' });
    return;
  }
  const original = { ...props.tweet };
  const wasLiked = (original.likeCount ?? 0) > 0;
  // Optimistic update: show result immediately
  emit('updated', { ...original, likeCount: (original.likeCount ?? 0) + (wasLiked ? -1 : 1) });
  try {
    const serverResult = await tweetStore.toggleFavorite(original);
    emit('updated', serverResult);
  } catch (e) {
    // Rollback on failure
    emit('updated', original);
    console.error('[onLike] failed:', e);
  }
}

async function onBookmark() {
  if (!tweetStore.loginUser) {
    router.push({ name: 'login' });
    return;
  }
  const original = { ...props.tweet };
  const wasBookmarked = (original.bookmarkCount ?? 0) > 0;
  emit('updated', { ...original, bookmarkCount: (original.bookmarkCount ?? 0) + (wasBookmarked ? -1 : 1) });
  try {
    const serverResult = await tweetStore.toggleBookmark(original);
    emit('updated', serverResult);
  } catch (e) {
    emit('updated', original);
    console.error('[onBookmark] failed:', e);
  }
}

function onShare() {
  showShareMenu.value = !showShareMenu.value;
}

async function copyLink() {
  const authorId = props.tweet.author?.mid || props.tweet.authorId;
  const url = `${window.location.origin}/tweet/${props.tweet.mid}${authorId ? '/' + authorId : ''}`;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
    showShareMenu.value = false;
  }, 15000);
}

function closeShareMenu() {
  showShareMenu.value = false;
}
</script>

<template>
  <div class="action-bar" @click.stop>
    <button class="action-btn" @click="onComment" :title="$t('tweet.comment')">
      <font-awesome-icon :icon="['far', 'comment']" />
      <span v-if="tweet.commentCount" class="action-count">{{ formatCount(tweet.commentCount) }}</span>
    </button>
    <button class="action-btn" @click="onRetweet" :title="$t('tweet.retweet')">
      <font-awesome-icon icon="retweet" />
      <span v-if="tweet.retweetCount" class="action-count">{{ formatCount(tweet.retweetCount) }}</span>
    </button>
    <button class="action-btn" :class="{ 'action-liked': isLiked }" @click="onLike" :title="$t('tweet.like')">
      <font-awesome-icon :icon="isLiked ? ['fas', 'heart'] : ['far', 'heart']" />
      <span v-if="tweet.likeCount" class="action-count">{{ formatCount(tweet.likeCount) }}</span>
    </button>
    <button class="action-btn" :class="{ 'action-bookmarked': isBookmarked }" @click="onBookmark" :title="$t('tweet.bookmark')">
      <font-awesome-icon :icon="isBookmarked ? ['fas', 'bookmark'] : ['far', 'bookmark']" />
      <span v-if="tweet.bookmarkCount" class="action-count">{{ formatCount(tweet.bookmarkCount) }}</span>
    </button>
    <div class="share-wrapper">
      <button class="action-btn" @click="onShare" :title="$t('tweet.share')">
        <font-awesome-icon icon="share-from-square" />
      </button>
      <div v-if="showShareMenu" class="share-menu">
        <button class="share-menu-item" @click="copyLink">
          <font-awesome-icon icon="copy" />
          <span>{{ copied ? $t('tweet.linkCopied') : $t('tweet.copyLink') }}</span>
        </button>
      </div>
      <div v-if="showShareMenu" class="share-backdrop" @click="closeShareMenu"></div>
    </div>
  </div>
</template>

<style scoped>
.action-bar {
  display: flex;
  justify-content: space-around;
  align-items: center;
  padding: 4px 0;
  margin: 0 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: #536471;
  font-size: 15px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 50px;
  transition: color 0.2s, background-color 0.2s;
}

.action-btn:hover {
  background-color: rgba(29, 155, 240, 0.1);
  color: #1d9bf0;
}

.action-btn.action-liked {
  color: #f91880;
}

.action-btn.action-liked:hover {
  background-color: rgba(249, 24, 128, 0.1);
  color: #f91880;
}

.action-btn.action-bookmarked {
  color: #1d9bf0;
}

.action-btn.action-bookmarked:hover {
  background-color: rgba(29, 155, 240, 0.1);
  color: #1d9bf0;
}

.action-count {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.share-wrapper {
  position: relative;
}

.share-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  min-width: 160px;
  z-index: 100;
  overflow: hidden;
}

.share-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: none;
  font-size: 14px;
  color: #333;
  cursor: pointer;
  white-space: nowrap;
}

.share-menu-item:hover {
  background-color: #f5f5f5;
}

.share-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 99;
}
</style>
