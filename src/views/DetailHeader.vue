<script setup lang='ts'>
import type { PropType } from 'vue';
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';

const props = defineProps({
  author: { type: Object as PropType<User>, required: true },
  timestamp: { type: Number, required: false },
  isRetweet: { type: Boolean, required: false, default: false },
  by: { type: String, required: false },
  /** Omit the tweet currently shown on the detail page from the carousel */
  excludeTweetId: { type: String, required: false }
});

const tweetStore = useTweetStore();
const router = useRouter();

function openUserPage(userId: string) {
  tweetStore.addFollowing(userId);
  router.push(`/author/${userId}`);
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

function excerptFromTweet(t: Tweet): string | null {
  const title = t.title?.trim();
  if (title) return title;
  const raw = t.content?.trim();
  if (!raw) return null;
  const plain = stripHtml(raw);
  return plain.length ? plain : null;
}

/** Excerpts paired with tweet ids for the rotating strip (tap opens profile at that tweet). */
const carouselItems = ref<{ excerpt: string; tweetId: string }[]>([]);
const currentIdx = ref(0);
/** After mount / author change: strip appears only after this is true (3s delay on first paint). */
const stripReady = ref(false);
let ticker: number | null = null;
let revealTimer: number | null = null;

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
  const userId = props.author.mid;
  const exclude = props.excludeTweetId;
  const merged = new Map<string, Tweet>();
  for (const t of tweetStore.getCachedUserTweets(userId)) {
    merged.set(t.mid, t);
  }
  for (const t of tweetStore.tweets) {
    if (t.authorId === userId) merged.set(t.mid, t);
  }
  const sorted = [...merged.values()].sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp)
  );
  const items: { excerpt: string; tweetId: string }[] = [];
  for (const t of sorted) {
    if (exclude && t.mid === exclude) continue;
    const ex = excerptFromTweet(t);
    if (ex) items.push({ excerpt: ex, tweetId: t.mid });
  }
  carouselItems.value = items;
  if (currentIdx.value >= items.length) currentIdx.value = 0;
}

async function loadPeerTweets() {
  const userId = props.author.mid;
  try {
    await tweetStore.loadTweetsByUser(userId, 0, 20);
  } catch (e) {
    console.warn('[DetailHeader] loadTweetsByUser failed', e);
  }
  rebuildCarousel();
}

onMounted(() => {
  rebuildCarousel();
  void loadPeerTweets();
  scheduleStripReveal(3000);
});

onUnmounted(() => {
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  clearCarouselTicker();
});

watch(
  () => props.author.mid,
  () => {
    currentIdx.value = 0;
    rebuildCarousel();
    void loadPeerTweets();
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    stripReady.value = true;
    startCarouselTicker();
  }
);

watch(
  () => props.excludeTweetId,
  () => {
    rebuildCarousel();
  }
);

watch(
  () =>
    tweetStore.tweets
      .filter((t) => t.authorId === props.author.mid)
      .map((t) => t.mid)
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
          <img :src='author.avatar' alt='User Avatar' class='rounded-circle' @click.stop='openUserPage(author.mid)'>
        </div>
        <div class='user-info flex-grow-1'>
          <div v-if='isRetweet' class='label text-muted small'>
            {{ $t('tweet.forwardedBy', { name: by }) }}
          </div>
          <div class='username-alias-time'>
            <span class='username fw-bold'>{{ author.name }}</span>
            <span class='alias text-muted'>@{{ author.username }}</span>
          </div>
          <div class='mt-1'>
            <span v-if='props.timestamp' class='time text-muted'>{{ formatTimeDifference(props.timestamp as number) }}</span>
          </div>
        </div>
      </div>
    </div>
    <div
      v-if='stripReady && carouselItems.length'
      class='author-carousel-outer'
      role='button'
      tabindex='0'
      @click.stop='openUserPageToTweet(author.mid, carouselItems[currentIdx].tweetId)'
      @keydown.enter.prevent.stop='openUserPageToTweet(author.mid, carouselItems[currentIdx].tweetId)'
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
.user-info {
  font-size: 0.9rem;
  flex-grow: 1;
}
.detail-header-root {
  width: 100%;
  margin: 2px 0 0 0;
}
.author-carousel-outer {
  width: calc(100% + 16px);
  max-width: none;
  margin-left: -8px;
  margin-right: -8px;
  margin-bottom: 0;
  margin-top: 0.25rem;
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