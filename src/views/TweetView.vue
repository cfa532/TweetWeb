<script setup lang='ts'>
import { onMounted, ref, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter, useRoute } from 'vue-router';
import { MediaView, ItemHeader } from '@/views';
import { useTweetStore } from '@/stores';
import { normalizeMediaType } from '@/lib';

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
  const attachments = mediaAttachments.value;
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
  // For 4+ items, check orientation of first 4 items
  if (count >= 4) {
    const ar0 = attachments[0].aspectRatio ?? 1;
    const ar1 = attachments[1].aspectRatio ?? 1;
    const ar2 = attachments[2].aspectRatio ?? 1;
    const ar3 = attachments[3].aspectRatio ?? 1;
    
    const allPortrait = ar0 < 1 && ar1 < 1 && ar2 < 1 && ar3 < 1;
    const allLandscape = ar0 > 1 && ar1 > 1 && ar2 > 1 && ar3 > 1;
    
    if (allPortrait) {
      return 0.8; // All portrait: aspect 0.8
    } else if (allLandscape) {
      return 1.618; // All landscape: golden ratio
    }
  }
  // Default for 4+ items (mixed orientations)
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

// Filter media attachments (image, video, audio only)
const mediaAttachments = computed(() => {
  const attachments = displayedTweet.value.attachments || [];
  return attachments.filter((attachment: MimeiFileType) => {
    const normalizedType = normalizeMediaType(attachment.type);
    return normalizedType.includes('image') || 
           normalizedType.includes('video') || 
           normalizedType.includes('audio');
  });
});

// Filter out media attachments (image, video, audio) to get documents
const documentAttachments = computed(() => {
  const attachments = displayedTweet.value.attachments || [];
  return attachments.filter((attachment: MimeiFileType) => {
    const normalizedType = normalizeMediaType(attachment.type);
    return !normalizedType.includes('image') && 
           !normalizedType.includes('video') && 
           !normalizedType.includes('audio');
  });
});

// Format file size in human-readable form
function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Handle document click - download the document with its filename
async function handleDocumentClick(event: MouseEvent, doc: MimeiFileType) {
  // Prevent the tweet detail view from opening
  event.stopPropagation();
  
  // Get the document URL
  let docUrl: string;
  
  // If mid is already a full URL, use it directly
  if (doc.mid.startsWith('http://') || doc.mid.startsWith('https://')) {
    docUrl = doc.mid;
  } else {
    // Extract hash from mid if it contains a path separator
    const lastIndexOf = doc.mid.lastIndexOf("/");
    const hash = lastIndexOf > 0 ? doc.mid.substring(lastIndexOf + 1) : doc.mid;
    
    // Get provider IP from the tweet
    const providerIp = displayedTweet.value.provider || displayedTweet.value.author?.providerIp;
    const baseUrl = providerIp ? `http://${providerIp}` : window.location.origin;
    
    // Construct the full URL using tweetStore.getMediaUrl
    docUrl = tweetStore.getMediaUrl(hash, baseUrl);
  }
  
  // Get the filename, fallback to a default name if not available
  const filename = doc.fileName || 'document';
  
  try {
    // Fetch the file as a blob
    const response = await fetch(docUrl);
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const blob = await response.blob();
    
    // Create a blob URL
    const blobUrl = window.URL.createObjectURL(blob);
    
    // Create download link with the filename
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up the blob URL after a short delay
    setTimeout(() => {
      window.URL.revokeObjectURL(blobUrl);
    }, 100);
  } catch (error) {
    console.error('Download failed:', error);
    // Fallback: open in new tab if download fails
    window.open(docUrl, '_blank');
  }
}

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
      <div v-if='mediaAttachments.length > 0' class='media-attachments' :style='{ aspectRatio: gridAspectRatio }'>
        <!-- 1 item -->
        <div v-if='mediaAttachments.length === 1' class='single-attachment'>
          <MediaView
            :media='mediaAttachments[0]'
            :tweet='displayedTweet'
            :media-list='mediaAttachments'
            :media-index='0'
            class='img-fluid portrait-center'
          ></MediaView>
        </div>
        
        <!-- 2 items -->
        <template v-else-if='mediaAttachments.length === 2'>
          <div v-if='isPortrait(mediaAttachments[0]) && isPortrait(mediaAttachments[1])' class='grid-2-portrait'>
            <MediaView
              v-for='(media, index) in mediaAttachments'
              :key='index'
              :media='media'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='index'
              class='grid-item'
            ></MediaView>
          </div>
          <div v-else-if='isLandscape(mediaAttachments[0]) && isLandscape(mediaAttachments[1])' class='grid-2-landscape'>
            <MediaView
              v-for='(media, index) in mediaAttachments'
              :key='index'
              :media='media'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='index'
              class='grid-item'
            ></MediaView>
          </div>
          <div v-else class='grid-2-mixed'>
            <MediaView
              :media='mediaAttachments[0]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='0'
              :class='["grid-item", isPortrait(mediaAttachments[0]) ? "grid-item-portrait" : "grid-item-landscape"]'
            ></MediaView>
            <MediaView
              :media='mediaAttachments[1]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='1'
              :class='["grid-item", isPortrait(mediaAttachments[1]) ? "grid-item-portrait" : "grid-item-landscape"]'
            ></MediaView>
          </div>
        </template>
        
        <!-- 3 items -->
        <template v-else-if='mediaAttachments.length === 3'>
          <div v-if='isPortrait(mediaAttachments[0]) && isPortrait(mediaAttachments[1]) && isPortrait(mediaAttachments[2])' class='grid-3-all-portrait'>
            <MediaView
              :media='mediaAttachments[0]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='0'
              class='grid-item grid-item-golden-left'
            ></MediaView>
            <div class='grid-item-golden-right'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='mediaAttachments[idx]'
                :tweet='displayedTweet'
                :media-list='mediaAttachments'
                :media-index='idx'
                class='grid-item'
              ></MediaView>
            </div>
          </div>
          <div v-else-if='isLandscape(mediaAttachments[0]) && isLandscape(mediaAttachments[1]) && isLandscape(mediaAttachments[2])' class='grid-3-all-landscape'>
            <MediaView
              :media='mediaAttachments[0]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='0'
              class='grid-item grid-item-golden-top'
            ></MediaView>
            <div class='grid-item-golden-bottom'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='mediaAttachments[idx]'
                :tweet='displayedTweet'
                :media-list='mediaAttachments'
                :media-index='idx'
                class='grid-item'
              ></MediaView>
            </div>
          </div>
          <div v-else-if='isPortrait(mediaAttachments[0])' class='grid-3-first-portrait'>
            <MediaView
              :media='mediaAttachments[0]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='0'
              class='grid-item grid-item-left-tall'
            ></MediaView>
            <div class='grid-item-right-stacked'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='mediaAttachments[idx]'
                :tweet='displayedTweet'
                :media-list='mediaAttachments'
                :media-index='idx'
                class='grid-item'
              ></MediaView>
            </div>
          </div>
          <div v-else class='grid-3-first-landscape'>
            <MediaView
              :media='mediaAttachments[0]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='0'
              class='grid-item grid-item-top-wide'
            ></MediaView>
            <div class='grid-item-bottom-two'>
              <MediaView
                v-for='idx in [1, 2]'
                :key='idx'
                :media='mediaAttachments[idx]'
                :tweet='displayedTweet'
                :media-list='mediaAttachments'
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
              :media='mediaAttachments[idx]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='idx'
              class='grid-item'
            ></MediaView>
          </div>
          <div class='grid-row'>
            <MediaView
              v-for='idx in [2, 3]'
              :key='idx'
              :media='mediaAttachments[idx]'
              :tweet='displayedTweet'
              :media-list='mediaAttachments'
              :media-index='idx'
              class='grid-item'
              :addtional-items='idx === 3 && mediaAttachments.length > 4 ? mediaAttachments.length - 4 : undefined'
            ></MediaView>
          </div>
        </div>
      </div>
      <div v-if='documentAttachments.length > 0' class='document-attachments'>
        <div 
          v-for='(doc, index) in documentAttachments' 
          :key='index' 
          class='document-row'
          @click='handleDocumentClick($event, doc)'
        >
          <span class='document-icon'>📄</span>
          <span class='document-filename'>{{ doc.fileName || 'Unknown file' }}</span>
          <span class='document-size'>{{ formatFileSize(doc.size) }}</span>
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
  height: 100%;
  display: block;
  position: relative;
  overflow: hidden;
  background-color: #000;
  margin: 0;
  padding: 0;
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
  vertical-align: middle !important;
  line-height: 0 !important;
}

/* Force videos to fill grid containers - highest specificity */
.media-attachments .grid-item .video-container,
.grid-item .video-container {
  width: 100% !important;
  height: 100% !important;
  display: block !important;
  position: relative !important;
  overflow: hidden !important;
  background-color: #000 !important;
  margin: 0 !important;
  padding: 0 !important;
  min-height: 0 !important;
}

.media-attachments .grid-item .video-wrapper,
.grid-item .video-wrapper {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  display: block !important;
  overflow: hidden !important;
  background-color: #000 !important;
  margin: 0 !important;
  padding: 0 !important;
  min-height: 0 !important;
}

.media-attachments .grid-item .video,
.grid-item .video {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  object-position: center !important;
  min-height: 0 !important;
  aspect-ratio: unset !important;
  max-width: none !important;
  max-height: none !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  vertical-align: middle !important;
  line-height: 0 !important;
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
  object-fit: cover;
  object-position: center;
  width: 100%;
  height: 100%;
}

/* Ensure single attachment media fills container */
.single-attachment .container {
  width: 100% !important;
  height: 100% !important;
  display: block !important;
  position: relative !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background-color: #000 !important;
}

.single-attachment .container img,
.single-attachment .container video,
.single-attachment .video-container,
.single-attachment .video-wrapper,
.single-attachment .video {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  object-position: center !important;
  max-width: none !important;
  max-height: none !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  vertical-align: middle !important;
  line-height: 0 !important;
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

.document-attachments {
  margin-top: 12px;
  padding: 8px;
  border-top: 1px solid #e0e0e0;
}

.document-row {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  margin-bottom: 6px;
  background-color: #f8f9fa;
  border-radius: 4px;
  transition: background-color 0.2s;
  cursor: pointer;
}

.document-row:hover {
  background-color: #e9ecef;
}

.document-row:last-child {
  margin-bottom: 0;
}

.document-icon {
  font-size: 20px;
  margin-right: 12px;
  flex-shrink: 0;
}

.document-filename {
  flex: 1;
  font-weight: 500;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.document-size {
  margin-left: 12px;
  color: #6c757d;
  font-size: 0.9em;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>