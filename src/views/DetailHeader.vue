<script setup lang='ts'>
import type { PropType } from 'vue';
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { formatTimeDifference, avatarSrc } from '@/lib';
import { UserAvatar } from '@/components';
import { useTweetStore } from '@/stores';
import { CornerMenu } from '@/views';

const props = defineProps({
  /** May be absent: a comment/tweet can render before (or without) its author resolving. */
  author: { type: Object as PropType<User | null>, required: false, default: null },
  /** Author id of the displayed tweet, used to pick up the User once it lands in the store. */
  authorId: { type: String, required: false },
  timestamp: { type: Number, required: false },
  isRetweet: { type: Boolean, required: false, default: false },
  by: { type: String, required: false },
  /** Omit the tweet currently shown on the detail page from the carousel */
  excludeTweetId: { type: String, required: false },
  tweet: { type: Object as PropType<Tweet>, required: false },
  editTweet: { type: Object as PropType<Tweet>, required: false },
  parentTweet: { type: Object as PropType<Tweet>, required: false },
  isComment: { type: Boolean, required: false, default: false },
  afterDelete: { type: Function as PropType<() => void | Promise<void>>, required: false }
});

const tweetStore = useTweetStore();
const router = useRouter();
const { t } = useI18n();

/**
 * The author may not have been resolved when the detail view opens (a failed or
 * still-pending getUser). Fall back to the store cache so the header fills in by
 * itself once the User arrives; until then the template shows a placeholder.
 */
const headerAuthor = computed<User | null>(() => {
  if (props.author) return props.author;
  const authorId = props.authorId;
  return authorId ? tweetStore.users.get(authorId) ?? null : null;
});
const authorMid = computed<string | null>(() => headerAuthor.value?.mid ?? null);
const authorDisplayName = computed(() => {
  const author = headerAuthor.value;
  if (!author) return t('tweet.loadingAuthor');
  return author.name?.trim() ? author.name : (author.username || t('tweet.loadingAuthor'));
});

function openUserPage(userId: string | null) {
  if (!userId) return;
  tweetStore.addFollowing(userId);
  router.push(`/author/${userId}`);
}

/**
 * One recovery attempt per author id: the detail fetch resolves authors itself,
 * but that call can fail (dead provider, cooldown) and leave the header without
 * one. getUser caches into tweetStore.users, which headerAuthor reads, so a late
 * success replaces the placeholder on its own. A failure keeps the placeholder.
 */
const attemptedAuthorIds = new Set<string>();
function ensureAuthorLoaded() {
  const authorId = props.authorId;
  if (!authorId || headerAuthor.value || attemptedAuthorIds.has(authorId)) return;
  attemptedAuthorIds.add(authorId);
  tweetStore.getUser(authorId).catch(() => undefined);
}

/** VITE_APP_LOGO is a remote URL; fall back to a same-origin asset if it fails too. */
function handleFallbackAvatarError(event: Event) {
  const img = event.target as HTMLImageElement | null;
  if (!img || img.src.endsWith('/ic_splash.png')) return;
  img.src = '/ic_splash.png';
}

function openUserPageToTweet(userId: string, tweetId: string) {
  tweetStore.addFollowing(userId);
  router.push({
    name: 'UserPage',
    params: { authorId: userId },
    query: { scrollTweet: tweetId },
  });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function excerptFromTweet(peer: Tweet): string | null {
  const title = peer.title?.trim();
  if (title) return title;
  const raw = peer.content?.trim();
  if (!raw) return null;
  const plain = stripHtml(raw);
  return plain.length ? plain : null;
}

/** Excerpts paired with tweet ids for the rotating strip (tap opens profile at that tweet). */
const carouselItems = ref<{ excerpt: string; tweetId: string }[]>([]);
const currentIdx = ref(0);
/** After mount / author change: strip appears only after this is true (5s delay on first paint). */
const stripReady = ref(false);
const TWEET_DETAIL_MEDIA_READY_EVENT = 'tweet-detail-media-ready';
const PEER_TWEETS_FALLBACK_DELAY_MS = 12000;
let ticker: number | null = null;
let revealTimer: number | null = null;
let peerTweetsTimer: number | null = null;
let removePeerTweetsReadyListener: (() => void) | null = null;

function clearCarouselTicker() {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function startCarouselTicker() {
  clearCarouselTicker();
  ticker = window.setInterval(() => {
    const n = carouselItems.value.length;
    if (n <= 1) return;
    currentIdx.value = (currentIdx.value + 1) % n;
  }, 5000);
}

function scheduleStripReveal(delayMs: number) {
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  revealTimer = window.setTimeout(() => {
    revealTimer = null;
    stripReady.value = true;
    startCarouselTicker();
  }, delayMs);
}

function rebuildCarousel() {
  const userId = authorMid.value;
  if (!userId) {
    carouselItems.value = [];
    currentIdx.value = 0;
    return;
  }
  const exclude = props.excludeTweetId;
  const merged = new Map<string, Tweet>();
  for (const peer of tweetStore.getCachedUserTweets(userId)) {
    merged.set(peer.mid, peer);
  }
  for (const peer of tweetStore.tweets) {
    if (peer.authorId === userId) merged.set(peer.mid, peer);
  }
  const sorted = [...merged.values()].sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp)
  );
  const items: { excerpt: string; tweetId: string }[] = [];
  for (const peer of sorted) {
    if (exclude && peer.mid === exclude) continue;
    const ex = excerptFromTweet(peer);
    if (ex) items.push({ excerpt: ex, tweetId: peer.mid });
  }
  carouselItems.value = items;
  if (currentIdx.value >= items.length) currentIdx.value = 0;
}

async function loadPeerTweets() {
  const userId = authorMid.value;
  if (!userId) return;
  try {
    await tweetStore.loadTweetsByUser(userId, 0, 20);
  } catch (e) {
    console.warn('[DetailHeader] loadTweetsByUser failed', e);
  }
  rebuildCarousel();
}

function clearPeerTweetsSchedule() {
  if (peerTweetsTimer !== null) {
    clearTimeout(peerTweetsTimer);
    peerTweetsTimer = null;
  }
  if (removePeerTweetsReadyListener) {
    removePeerTweetsReadyListener();
    removePeerTweetsReadyListener = null;
  }
}

function schedulePeerTweetsLoad() {
  clearPeerTweetsSchedule();
  const scheduledAuthorId = authorMid.value;
  if (!scheduledAuthorId) return;
  let started = false;
  const start = () => {
    if (started || authorMid.value !== scheduledAuthorId) return;
    started = true;
    clearPeerTweetsSchedule();
    void loadPeerTweets();
  };
  const onMediaReady = () => start();
  window.addEventListener(TWEET_DETAIL_MEDIA_READY_EVENT, onMediaReady, { once: true });
  removePeerTweetsReadyListener = () => {
    window.removeEventListener(TWEET_DETAIL_MEDIA_READY_EVENT, onMediaReady);
  };
  peerTweetsTimer = window.setTimeout(start, PEER_TWEETS_FALLBACK_DELAY_MS);
}

onMounted(() => {
  ensureAuthorLoaded();
  rebuildCarousel();
  schedulePeerTweetsLoad();
  scheduleStripReveal(5000);
});

watch(() => props.authorId, () => ensureAuthorLoaded());

onUnmounted(() => {
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  clearPeerTweetsSchedule();
  clearCarouselTicker();
});

watch(authorMid, (newMid, oldMid) => {
  currentIdx.value = 0;
  rebuildCarousel();
  schedulePeerTweetsLoad();
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  if (!newMid) {
    stripReady.value = false;
    clearCarouselTicker();
    return;
  }
  if (!oldMid) {
    // Author arrived late (placeholder header): give the page the same brief
    // settle time the first paint gets before the strip appears.
    scheduleStripReveal(5000);
    return;
  }
  stripReady.value = true;
  startCarouselTicker();
});

watch(
  () => props.excludeTweetId,
  () => {
    rebuildCarousel();
  }
);

watch(
  () =>
    tweetStore.tweets
      .filter((tweet) => tweet.authorId === authorMid.value)
      .map((tweet) => tweet.mid)
      .sort()
      .join(','),
  () => rebuildCarousel()
);
</script>

<template>
  <div class='detail-header-root'>
    <div class='d-flex justify-content-between align-items-center' style='width: 100%'>
      <div class='d-flex align-items-center'>
        <div class='avatar me-2'>
          <UserAvatar v-if='headerAuthor' :user='headerAuthor' alt='User Avatar' class='rounded-circle'
            @click.stop='openUserPage(headerAuthor.mid)' />
          <img v-else :src='avatarSrc(undefined)' alt='User Avatar' class='rounded-circle placeholder-avatar'
            @error='handleFallbackAvatarError' />
        </div>
        <div class='user-info flex-grow-1'>
          <div v-if='isRetweet && by' class='label text-muted small'>
            {{ by === tweetStore.loginUser?.username ? $t('tweet.forwardedByYou') : $t('tweet.forwardedBy', { name: by }) }}
          </div>
          <div class='username-alias-time'>
            <span class='username fw-bold' :class='{ "loading-text": !headerAuthor }'>{{ authorDisplayName }}</span>
            <span class='alias text-muted' :class='{ "loading-text": !headerAuthor }'>@{{ headerAuthor?.username ||
              $t('tweet.loadingUsername') }}</span>
          </div>
          <div class='mt-1'>
            <span v-if='props.timestamp' class='time text-muted'>{{ formatTimeDifference(props.timestamp as number) }}</span>
          </div>
        </div>
      </div>
      <div v-if='tweet' class='corner-menu-container' @click.stop>
        <!-- share-url-style is left at its 'deeplink' default so the detail corner
             menu shares the same link as the feed corner menu. -->
        <CornerMenu :tweet='tweet' :edit-tweet='editTweet' :parent-tweet='parentTweet' :is-comment='isComment'
          :after-delete='afterDelete' />
      </div>
    </div>
    <div
      v-if='stripReady && carouselItems.length && authorMid'
      class='author-carousel-outer'
      role='button'
      tabindex='0'
      @click.stop='openUserPageToTweet(authorMid, carouselItems[currentIdx].tweetId)'
      @keydown.enter.prevent.stop='openUserPageToTweet(authorMid, carouselItems[currentIdx].tweetId)'
    >
      <Transition name='carousel-spin' mode='out-in'>
        <div
          :key='currentIdx'
          class='author-carousel-slide small'
          :title='carouselItems[currentIdx].excerpt'
        >
          <span class='author-carousel-text'>{{ carouselItems[currentIdx].excerpt }}</span>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.text-muted {
  font-size: 0.95rem;
}
.username {
  font-size: 0.9rem;
}
.alias {
  font-size: 1rem;
}
.avatar {
  display: flex;
  align-items: center;
}
.avatar img {
  object-fit: cover;
  width: 50px;
  height: 50px;
  cursor: pointer;
}
/* Author could not be resolved (yet): grey pulsing stand-ins, same as ItemHeader. */
.placeholder-avatar {
  cursor: default;
  background: #e9ecef;
  animation: detail-header-pulse 1.5s ease-in-out infinite;
}
.loading-text {
  background: #e9ecef;
  color: transparent;
  border-radius: 4px;
  animation: detail-header-pulse 1.5s ease-in-out infinite;
}
@keyframes detail-header-pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
.user-info {
  font-size: 0.9rem;
  flex-grow: 1;
}
.detail-header-root {
  width: 100%;
  margin: 0;
  padding: 8px 0;
}
.corner-menu-container {
  height: 100%;
  display: flex;
  /* Above flex siblings so mobile hit-testing targets the menu, not the card header */
  position: relative;
  z-index: 2;
}
.author-carousel-outer {
  width: calc(100% + 16px);
  max-width: none;
  margin-left: -8px;
  margin-right: -8px;
  margin-bottom: -8px;
  margin-top: 0.5rem;
  overflow: hidden;
  perspective: 720px;
  transform-style: preserve-3d;
  cursor: pointer;
}
.author-carousel-slide {
  width: 100%;
  box-sizing: border-box;
  padding: 0.35rem 8px;
  border-radius: 0;
  background-color: #25292e;
  transform-origin: center center;
  backface-visibility: hidden;
}
.author-carousel-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.88);
}
.carousel-spin-enter-active,
.carousel-spin-leave-active {
  transition:
    opacity 0.45s ease,
    transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.carousel-spin-enter-from {
  opacity: 0;
  transform: rotateX(90deg);
}
.carousel-spin-leave-to {
  opacity: 0;
  transform: rotateX(-90deg);
}

/* TweetDetail mobile: .card-header has padding-left 8px only */
@media (max-width: 575px) {
  .author-carousel-outer {
    width: calc(100% + 8px);
    margin-left: -8px;
    margin-right: 0;
  }
}
</style>
