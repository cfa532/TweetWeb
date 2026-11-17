<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PropType } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAlertStore, useTweetStore } from '@/stores';
import { requireLoginForWritableAction } from '@/lib/authNavigation';
import { copyTextToClipboard, tweetShareUrl } from '@/lib';

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const tweetStore = useTweetStore();
const alertStore = useAlertStore();
const showShareMenu = ref(false);
const copied = ref(false);
let lastRetweetTap: { mid: string; time: number } | undefined;

const props = defineProps({
  tweet: { type: Object as PropType<Tweet>, required: true },
  commentParentId: { type: String, required: false },
  commentParentAuthorId: { type: String, required: false },
});

const emit = defineEmits<{
  (e: 'updated', tweet: Tweet): void;
}>();

// Server returns per-appUser flags as tweet.favorites: [favorite, bookmark, retweeted].
// Index matches iOS UserActions.{FAVORITE=0, BOOKMARK=1, RETWEET=2}.
const FAVORITE_IDX = 0;
const BOOKMARK_IDX = 1;
const resolvedFavorites = computed(() => tweetStore.resolvedInteractionFlags(props.tweet));
const isLiked = computed(() => !!resolvedFavorites.value[FAVORITE_IDX] && tweetStore.loginUser != null);
const isBookmarked = computed(() => !!resolvedFavorites.value[BOOKMARK_IDX] && tweetStore.loginUser != null);

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
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) return;
  router.push({ name: 'post', params: { tweetId: props.tweet.mid } });
}

async function onRetweet() {
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) return;
  const mid = props.tweet.mid;
  const time = performance.now();
  if (lastRetweetTap?.mid === mid && time - lastRetweetTap.time < 2000) return;
  lastRetweetTap = { mid, time };
  alertStore.info(t('tweet.retweetStarted'), { durationMs: 2000 });
  const target = { ...props.tweet };
  try {
    const previousCount = target.retweetCount;
    await tweetStore.retweetTweet(target, props.commentParentId, props.commentParentAuthorId);
    if (target.retweetCount !== previousCount) emit('updated', target);
  } catch (e) {
    console.error('[onRetweet] failed:', e);
    alertStore.error(e, { fallbackMessage: t('tweet.retweetFailed') });
  }
}

/** Build a new favorites array with index `idx` flipped. Defaults to
 *  [false, false, false] when missing so the action bar always has a
 *  3-slot array to work with. */
function flipFavoriteAt(current: boolean[] | undefined, idx: number): boolean[] {
  const next = current ? [...current] : [false, false, false];
  while (next.length < 3) next.push(false);
  next[idx] = !next[idx];
  return next;
}

async function onLike() {
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) return;
  const original = {
    ...props.tweet,
    favorites: [...resolvedFavorites.value],
    favoriteOverride: resolvedFavorites.value[FAVORITE_IDX],
    bookmarkOverride: resolvedFavorites.value[BOOKMARK_IDX],
  };
  const wasLiked = !!original.favorites?.[FAVORITE_IDX];
  const desiredFavorite = !wasLiked;
  const optimisticTweet = tweetStore.applyOptimisticSavedTweet({
    ...original,
    favorites: flipFavoriteAt(original.favorites, FAVORITE_IDX),
    favoriteOverride: desiredFavorite,
  }, 'favorite', desiredFavorite, wasLiked);
  emit('updated', optimisticTweet);
  try {
    const serverResult = await tweetStore.toggleFavorite(original, desiredFavorite);
    emit('updated', serverResult);
  } catch (e) {
    const rolledBackTweet = tweetStore.applyOptimisticSavedTweet(
      original,
      'favorite',
      wasLiked,
      desiredFavorite,
      'rollback',
    );
    emit('updated', rolledBackTweet);
    console.error('[onLike] failed:', e);
    alertStore.error(e, { fallbackMessage: t('tweet.likeFailed') });
  }
}

async function onBookmark() {
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) return;
  const original = {
    ...props.tweet,
    favorites: [...resolvedFavorites.value],
    favoriteOverride: resolvedFavorites.value[FAVORITE_IDX],
    bookmarkOverride: resolvedFavorites.value[BOOKMARK_IDX],
  };
  const wasBookmarked = !!original.favorites?.[BOOKMARK_IDX];
  const desiredBookmark = !wasBookmarked;
  const optimisticTweet = tweetStore.applyOptimisticSavedTweet({
    ...original,
    favorites: flipFavoriteAt(original.favorites, BOOKMARK_IDX),
    bookmarkOverride: desiredBookmark,
  }, 'bookmark', desiredBookmark, wasBookmarked);
  emit('updated', optimisticTweet);
  try {
    const serverResult = await tweetStore.toggleBookmark(original, desiredBookmark);
    emit('updated', serverResult);
  } catch (e) {
    const rolledBackTweet = tweetStore.applyOptimisticSavedTweet(
      original,
      'bookmark',
      wasBookmarked,
      desiredBookmark,
      'rollback',
    );
    emit('updated', rolledBackTweet);
    console.error('[onBookmark] failed:', e);
    alertStore.error(e, { fallbackMessage: t('tweet.bookmarkFailed') });
  }
}

function onShare() {
  showShareMenu.value = !showShareMenu.value;
}

async function copyLink() {
  await copyTextToClipboard(tweetShareUrl(props.tweet, 'http://dtweet.com'));
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
    <button v-if="!tweet.savedTweetUnavailable" class="action-btn" @click="onComment" :title="$t('tweet.comment')">
      <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.75,11C20.75,15.6 16.9,19 12,19H9.25L3.25,21L4.35,15.95C3.64,14.62 3.25,13.05 3.25,11.35C3.25,6.74 7.17,3.25 12,3.25C16.83,3.25 20.75,6.47 20.75,11Z" />
      </svg>
      <span v-if="tweet.commentCount" class="action-count">{{ formatCount(tweet.commentCount) }}</span>
    </button>
    <button v-if="!tweet.savedTweetUnavailable" class="action-btn" @click="onRetweet" :title="$t('tweet.retweet')">
      <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.25,8L6,4.25L9.75,8M6,4.25V16.75C6,17.85 6.9,18.75 8,18.75H12.25M14.25,16L18,19.75L21.75,16M18,19.75V7.25C18,6.15 17.1,5.25 16,5.25H11.75" />
      </svg>
      <span v-if="tweet.retweetCount" class="action-count">{{ formatCount(tweet.retweetCount) }}</span>
    </button>
    <button v-if="!tweet.savedTweetUnavailable || isLiked" class="action-btn" :class="{ 'action-liked': isLiked }" @click="onLike" :title="$t('tweet.like')">
      <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12,20.5L4.78,13.63C3.63,12.54 3,11.18 3,9.65C3,6.74 5.08,4.5 7.83,4.5C9.64,4.5 10.96,5.38 12,6.7C13.04,5.38 14.36,4.5 16.17,4.5C18.92,4.5 21,6.74 21,9.65C21,11.18 20.37,12.54 19.22,13.63L12,20.5Z" :fill="isLiked ? 'currentColor' : 'none'" />
      </svg>
      <span v-if="tweet.likeCount" class="action-count">{{ formatCount(tweet.likeCount) }}</span>
    </button>
    <button v-if="!tweet.savedTweetUnavailable || isBookmarked" class="action-btn" :class="{ 'action-bookmarked': isBookmarked }" @click="onBookmark" :title="$t('tweet.bookmark')">
      <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6,3H18C18.55,3 19,3.45 19,4V21L12,17L5,21V4C5,3.45 5.45,3 6,3Z" :fill="isBookmarked ? 'currentColor' : 'none'" />
      </svg>
      <span v-if="tweet.bookmarkCount" class="action-count">{{ formatCount(tweet.bookmarkCount) }}</span>
    </button>
    <div v-if="!tweet.savedTweetUnavailable" class="share-wrapper">
      <button class="action-btn" @click="onShare" :title="$t('tweet.share')">
        <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12,15V3M8,7L12,3L16,7M8,10H5C4.45,10 4,10.45 4,11V20C4,20.55 4.45,21 5,21H19C19.55,21 20,20.55 20,20V11C20,10.45 19.55,10 19,10H16" />
        </svg>
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
  padding: 4px 0 12px 0;
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

.action-icon {
  width: 19px;
  height: 19px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
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
