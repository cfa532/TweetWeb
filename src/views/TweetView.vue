<script setup lang='ts'>
import { onMounted, ref, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter, useRoute } from 'vue-router';
import { MediaView, ItemHeader } from '@/views';
import { useTweetStore } from '@/stores';

const tweetStore = useTweetStore()
const router = useRouter()
const route = useRoute()

const props = defineProps({
  tweet: { type: Object as PropType<Tweet>, required: true },
  isQuoted: { type: Boolean, required: false, default: false },
  isComment: { type: Boolean, required: false, default: false },
  parentTweet: { type: Object as PropType<Tweet>, required: false }
});

const originalTweet = ref<Tweet | null>();
const isRetweet = ref(false);
const retweetedBy = ref<string | undefined>(undefined);
const currentTweet = ref(props.tweet);
const isContentClipped = ref(false);

const MAX_LINES = 10;
const MAX_CHARS_CHINESE = 300;

onMounted(async () => {
  if (currentTweet.value.originalTweetId) {
    originalTweet.value = await tweetStore.fetchTweet(
      currentTweet.value.originalTweetId,
      currentTweet.value.originalAuthorId
    );

    if (originalTweet.value) {
      if (!currentTweet.value.content && !currentTweet.value.attachments) {
        // A retweet.
        retweetedBy.value = currentTweet.value.author.username;
        isRetweet.value = true;
      }
    }
  }
});

const displayedTweet = computed(() => {
  return isRetweet.value && originalTweet.value ? originalTweet.value : currentTweet.value;
});

function openDetailView() {
    sessionStorage.setItem('tweetDetail', JSON.stringify(displayedTweet.value));
    const basePath = `/tweet/${displayedTweet.value.mid}/${displayedTweet.value.author.mid}`;
    if (props.isComment) {
        // Get parent tweet ID from the route if available
        const parentTweetId = route.params.tweetId as string;
        const parentAuthorId = route.params.authorId as string;
        router.push(`${basePath}?fromComment=true&parentTweetId=${parentTweetId}&parentAuthorId=${parentAuthorId}`);
    } else {
        router.push(basePath);
    }
}

function linkify(text: string) {
  const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
  return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}

const processedContent = computed(() => {
  if (!displayedTweet.value.content) {
    return '';
  }

  const linkedText = linkify(displayedTweet.value.content);
  const isChinese = /[\u4e00-\u9fa5]/.test(linkedText); // Basic check for Chinese characters

  if ((isChinese && linkedText.length > MAX_CHARS_CHINESE) || (!isChinese && linkedText.split('\n').length > MAX_LINES)) {
    isContentClipped.value = true;
    if (isChinese) {
      return linkedText.substring(0, MAX_CHARS_CHINESE) + '...';
    } else {
      const lines = linkedText.split('\n');
      return lines.slice(0, MAX_LINES).join('\n') + '...';
    }
  } else {
    isContentClipped.value = false;
    return linkedText;
  }
});

// iOS MediaGrid algorithm implementation
const gridAspectRatio = computed(() => {
  const attachments = displayedTweet.value.attachments || [];
  const count = attachments.length;
  
  if (count === 0) return 1;
  if (count === 1) {
    const ar = attachments[0].aspectRatio || 1;
    if (ar < 0.9) return 0.9; // Portrait aspect ratio
    return ar; // Use actual aspect ratio for landscape
  }
  if (count === 2) {
    const ar0 = attachments[0].aspectRatio ?? 1;
    const ar1 = attachments[1].aspectRatio ?? 1;
    const isPortrait0 = ar0 < 1;
    const isPortrait1 = ar1 < 1;
    const isLandscape0 = ar0 > 1;
    const isLandscape1 = ar1 > 1;
    
    if (isPortrait0 && isPortrait1) {
      return 3.0 / 2.0; // Both portrait: horizontal, aspect 3:2
    } else if (isLandscape0 && isLandscape1) {
      return 4.0 / 5.0; // Both landscape: vertical, aspect 4:5
    } else {
      return 2.0; // Mixed: horizontal, aspect 2:1
    }
  }
  // For 4+ items, always use square (1:1) aspect ratio
  return 1.0;
});

const isPortrait = (attachment: MimeiFileType) => {
  const ar = attachment.aspectRatio || 1;
  return ar < 1.0;
};

const isLandscape = (attachment: MimeiFileType) => {
  const ar = attachment.aspectRatio || 1;
  return ar > 1.0;
};

</script>

<template>
  <div class='card ms-1 tweet-container'>
    <div class='card-header d-flex align-items-start' @click.prevent='openDetailView'>
      <ItemHeader
        :tweet='originalTweet'
        :author='originalTweet?.author'
        :timestamp='displayedTweet.timestamp as number'
        :is-retweet='isRetweet'
        :by='retweetedBy'
        :parent-tweet='parentTweet'
        :is-comment='isComment'
        v-if='isRetweet && originalTweet'
      />
      <ItemHeader
        v-else
        :tweet='displayedTweet'
        :author='displayedTweet.author'
        :timestamp='displayedTweet.timestamp as number'
        :parent-tweet='parentTweet'
        :is-comment='isComment'
      />
    </div>
    <div class='card-body' :id="props.tweet.mid">
      <p v-if='displayedTweet.content' class='card-text' v-html='processedContent'></p>
      <div v-if='displayedTweet.attachments?.length' class='media-attachments' :style='{ aspectRatio: gridAspectRatio }'>
        <!-- 1 item -->
        <div v-if='displayedTweet.attachments.length === 1' class='single-attachment'>
          <MediaView
            :media='displayedTweet.attachments[0]'
            :tweet='displayedTweet'
            :media-list='displayedTweet.attachments'
            :media-index='0'
            class='img-fluid portrait-center'
          ></MediaView>
        </div>
        
        <!-- 2 items -->
        <template v-else-if='displayedTweet.attachments.length === 2'>
          <div v-if='isPortrait(displayedTweet.attachments[0]) && isPortrait(displayedTweet.attachments[1])' class='grid-2-portrait'>
            <MediaView
              v-for='(media, index) in displayedTweet.attachments'
              :key='index'
              :media='media'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='index'
              class='grid-item'
            ></MediaView>
          </div>
          <div v-else-if='isLandscape(displayedTweet.attachments[0]) && isLandscape(displayedTweet.attachments[1])' class='grid-2-landscape'>
            <MediaView
              v-for='(media, index) in displayedTweet.attachments'
              :key='index'
              :media='media'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='index'
              class='grid-item'
            ></MediaView>
          </div>
          <div v-else class='grid-2-mixed'>
            <MediaView
              :media='displayedTweet.attachments[0]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='0'
              :class='["grid-item", isPortrait(displayedTweet.attachments[0]) ? "grid-item-portrait" : "grid-item-landscape"]'
            ></MediaView>
            <MediaView
              :media='displayedTweet.attachments[1]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='1'
              :class='["grid-item", isPortrait(displayedTweet.attachments[1]) ? "grid-item-portrait" : "grid-item-landscape"]'
            ></MediaView>
          </div>
        </template>
        
        <!-- 3 items -->
        <template v-else-if='displayedTweet.attachments.length === 3'>
          <div v-if='isPortrait(displayedTweet.attachments[0]) && isPortrait(displayedTweet.attachments[1]) && isPortrait(displayedTweet.attachments[2])' class='grid-3-all-portrait'>
            <MediaView
              :media='displayedTweet.attachments[0]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='0'
              class='grid-item grid-item-golden-left'
            ></MediaView>
            <div class='grid-item-golden-right'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='displayedTweet.attachments[idx]'
                :tweet='displayedTweet'
                :media-list='displayedTweet.attachments'
                :media-index='idx'
                class='grid-item'
              ></MediaView>
            </div>
          </div>
          <div v-else-if='isLandscape(displayedTweet.attachments[0]) && isLandscape(displayedTweet.attachments[1]) && isLandscape(displayedTweet.attachments[2])' class='grid-3-all-landscape'>
            <MediaView
              :media='displayedTweet.attachments[0]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='0'
              class='grid-item grid-item-golden-top'
            ></MediaView>
            <div class='grid-item-golden-bottom'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='displayedTweet.attachments[idx]'
                :tweet='displayedTweet'
                :media-list='displayedTweet.attachments'
                :media-index='idx'
                class='grid-item'
              ></MediaView>
            </div>
          </div>
          <div v-else-if='isPortrait(displayedTweet.attachments[0])' class='grid-3-first-portrait'>
            <MediaView
              :media='displayedTweet.attachments[0]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='0'
              class='grid-item grid-item-left-tall'
            ></MediaView>
            <div class='grid-item-right-stacked'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='displayedTweet.attachments[idx]'
                :tweet='displayedTweet'
                :media-list='displayedTweet.attachments'
                :media-index='idx'
                class='grid-item'
              ></MediaView>
            </div>
          </div>
          <div v-else class='grid-3-first-landscape'>
            <MediaView
              :media='displayedTweet.attachments[0]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='0'
              class='grid-item grid-item-top-wide'
            ></MediaView>
            <div class='grid-item-bottom-two'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='displayedTweet.attachments[idx]'
                :tweet='displayedTweet'
                :media-list='displayedTweet.attachments'
                :media-index='idx'
                class='grid-item'
              ></MediaView>
            </div>
          </div>
        </template>
        
        <!-- 4+ items -->
        <div v-else class='grid-4-plus'>
          <div class='grid-row'>
            <MediaView
              v-for='idx in [0, 1]'
              :key='idx'
              :media='displayedTweet.attachments[idx]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='idx'
              class='grid-item'
            ></MediaView>
          </div>
          <div class='grid-row'>
            <MediaView
              v-for='idx in [2, 3]'
              :key='idx'
              :media='displayedTweet.attachments[idx]'
              :tweet='displayedTweet'
              :media-list='displayedTweet.attachments'
              :media-index='idx'
              class='grid-item'
              :addtional-items='idx === 3 && displayedTweet.attachments.length > 4 ? displayedTweet.attachments.length - 4 : undefined'
            ></MediaView>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tweet-container {
  overflow: hidden;
  max-height: 80vh;
}

.single-attachment {
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  max-height: 50vh;
  overflow: hidden;
  background-color: #000;
}

.media-attachments {
  width: 100%;
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  background-color: #000;
}

/* iOS MediaGrid Algorithm Styles */
.media-attachments {
  width: 100%;
  position: relative;
  border-radius: 8px;
  overflow: hidden;
}

.grid-item {
  width: 100%;
  height: 100%;
  display: block;
  overflow: hidden;
  position: relative;
  background-color: #000;
  min-width: 0;
  min-height: 0;
}

/* Ensure MediaView container fills the grid item */
.grid-item > * {
  width: 100%;
  height: 100%;
  display: block;
}

.grid-item .container {
  width: 100% !important;
  height: 100% !important;
  display: block !important;
  overflow: hidden;
  background-color: #000;
  margin: 0 !important;
  padding: 0 !important;
  position: relative;
}

/* Force images in grid to fill containers - override Bootstrap img-fluid */
.media-attachments .grid-item,
.media-attachments .grid-item .container,
.media-attachments .grid-item .container img {
  width: 100% !important;
  height: 100% !important;
}

.media-attachments .grid-item .container {
  position: relative !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background-color: #000 !important;
}

/* Force images to fill grid containers - highest specificity */
.media-attachments .grid-item .container {
  position: relative !important;
}

.media-attachments .grid-item .container img,
.media-attachments .grid-item .container > img,
.media-attachments .grid-item img {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  object-position: center !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  max-width: none !important;
  max-height: none !important;
  min-width: 0 !important;
  min-height: 0 !important;
}

.grid-item .video-container {
  width: 100% !important;
  height: 100% !important;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background-color: #000;
  margin: 0;
  padding: 0;
  min-height: 0;
}

.grid-item .video-wrapper {
  width: 100% !important;
  height: 100% !important;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  margin: 0;
  padding: 0;
  min-height: 0;
}

.grid-item .video {
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  object-position: center;
  min-height: 0;
  aspect-ratio: unset !important;
  margin: 0;
  padding: 0;
}

/* 2 items - Both portrait: horizontal layout */
.grid-2-portrait {
  display: flex;
  flex-direction: row;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.grid-2-portrait .grid-item {
  flex: 1 1 0;
  min-width: 0;
}

/* 2 items - Both landscape: vertical layout */
.grid-2-landscape {
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.grid-2-landscape .grid-item {
  flex: 1 1 0;
  min-height: 0;
}

/* 2 items - Mixed: horizontal, portrait 1/3, landscape 2/3 */
.grid-2-mixed {
  display: flex;
  flex-direction: row;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.grid-2-mixed .grid-item-portrait {
  flex: 0 0 33.333%;
  min-width: 0;
}

.grid-2-mixed .grid-item-landscape {
  flex: 0 0 66.666%;
  min-width: 0;
}

/* 3 items - All portrait: golden ratio layout */
.grid-3-all-portrait {
  display: flex;
  flex-direction: row;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.grid-3-all-portrait .grid-item-golden-left {
  flex: 0 0 61.8%;
  min-width: 0;
}

.grid-3-all-portrait .grid-item-golden-right {
  flex: 0 0 38.2%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.grid-3-all-portrait .grid-item-golden-right .grid-item {
  flex: 1 1 0;
  min-height: 0;
}

/* 3 items - All landscape: golden ratio layout */
.grid-3-all-landscape {
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.grid-3-all-landscape .grid-item-golden-top {
  flex: 0 0 61.8%;
  min-height: 0;
}

.grid-3-all-landscape .grid-item-golden-bottom {
  flex: 0 0 38.2%;
  min-height: 0;
  display: flex;
  flex-direction: row;
  gap: 2px;
}

.grid-3-all-landscape .grid-item-golden-bottom .grid-item {
  flex: 1 1 0;
  min-width: 0;
}

/* 3 items - First portrait: left tall, right stacked */
.grid-3-first-portrait {
  display: flex;
  flex-direction: row;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.grid-3-first-portrait .grid-item-left-tall {
  flex: 0 0 50%;
  min-width: 0;
}

.grid-3-first-portrait .grid-item-right-stacked {
  flex: 0 0 50%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.grid-3-first-portrait .grid-item-right-stacked .grid-item {
  flex: 1 1 0;
  min-height: 0;
}

/* 3 items - First landscape: top wide, bottom two */
.grid-3-first-landscape {
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.grid-3-first-landscape .grid-item-top-wide {
  flex: 0 0 50%;
  min-height: 0;
}

.grid-3-first-landscape .grid-item-bottom-two {
  flex: 0 0 50%;
  min-height: 0;
  display: flex;
  flex-direction: row;
  gap: 2px;
}

.grid-3-first-landscape .grid-item-bottom-two .grid-item {
  flex: 1 1 0;
  min-width: 0;
}

/* 4+ items - 2x2 grid */
.grid-4-plus {
  display: flex;
  flex-direction: column;
  gap: 1px;
  height: 100%;
  width: 100%;
  margin: 0;
  padding: 0;
}

.grid-4-plus .grid-row {
  display: flex;
  flex-direction: row;
  gap: 1px;
  flex: 1 1 0;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: none;
}

.grid-4-plus .grid-row .grid-item {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  position: relative;
  margin: 0;
  padding: 0;
  border: none;
}

.portrait-center {
  object-fit: contain;
  object-position: top;
  max-height: 100%;
  max-width: 100%;
}

.card {
  width: 100%;
  margin: 0 0 15px 0;
}
.card-header {
  margin: 0;
  padding: 0 8px;
  cursor: pointer;
  background-color: solid #888;
}
.card-body {
  margin: 0;
  padding: 0;
}

.card-text {
  text-align: left;
  font-size: medium;
  white-space: pre-wrap;
  padding: 4px 0 0 8px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: v-bind('isContentClipped ? MAX_LINES : undefined');
  -webkit-box-orient: vertical;
}

.card-text a {
  color: blue;
  text-decoration: underline;
}

.icon-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.icon-number {
  position: absolute;
  bottom: -1px;
  right: -15px;
  font-size: 15px;
  color: rgba(0, 0, 0, 0.819);
}

.icon-row {
  display: flex;
  justify-content: space-around;
}

.icon {
  width: 18px;
  height: 18px;
  transition: transform 0.3s;
  cursor: pointer;
}

.icon:hover {
  transform: scale(1.1);
}

.icon-item span {
  margin-top: 5px;
  color: rgba(0, 0, 0, 0.787);
  font-weight: bold;
  pointer-events: none;
}
</style>