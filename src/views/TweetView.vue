<script setup lang='ts'>
import { onMounted, ref, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { MediaView, ItemHeader } from '@/views';
import { useTweetStore } from '@/stores';

const tweetStore = useTweetStore()
const router = useRouter()

const props = defineProps({
  tweet: {
    type: Object as PropType<Tweet>,
    required: true
  },
  isQuoted: {
    type: Boolean,
    required: false,
    default: false
  }
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
  router.push(`/tweet/${displayedTweet.value.mid}/${displayedTweet.value.author.mid}`);
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

const attachmentGridColumns = computed(() => {
  const attachmentCount = displayedTweet.value.attachments?.length || 0;
  return (attachmentCount === 2 || attachmentCount >= 3) ? 'repeat(2, 1fr)' : '';
});

const attachmentGridRows = computed(() => {
  const attachmentCount = displayedTweet.value.attachments?.length || 0;
  return attachmentCount <= 2 ? '1fr' : (attachmentCount >= 3 ? 'repeat(2, 1fr)' : '');
});

</script>

<template>
  <div @click.prevent='openDetailView' class='card ms-1 tweet-container'>
    <div class='card-header d-flex align-items-start'>
      <ItemHeader
        :tweet='originalTweet'
        :author='originalTweet?.author'
        :timestamp='displayedTweet.timestamp as number'
        :is-retweet='isRetweet'
        :by='retweetedBy'
        v-if='isRetweet && originalTweet'
      />
      <ItemHeader
        v-else
        :tweet='displayedTweet'
        :author='displayedTweet.author'
        :timestamp='displayedTweet.timestamp as number'
      />
    </div>
    <div class='card-body'>
      <p v-if='displayedTweet.content' class='card-text' v-html='processedContent'></p>
      <div v-if='displayedTweet.attachments?.length' class='media-attachments'>
        <div v-if='displayedTweet.attachments.length === 1' class='single-attachment'>
          <MediaView
            :media='displayedTweet.attachments[0]'
            :tweet='displayedTweet'
            class='img-fluid portrait-center'
          ></MediaView>
        </div>
        <div v-else-if='displayedTweet.attachments.length > 1' :class='["multiple-attachments"]' :style='{ "grid-template-columns": attachmentGridColumns, "grid-template-rows": attachmentGridRows }'>
          <MediaView
            v-for='(media, index) in displayedTweet.attachments.slice(0, 4)'
            :media='media'
            :tweet='displayedTweet'
            :key='index'
            class='img-fluid'
            :addtional-items='
              index === 3 && displayedTweet.attachments.length > 4
                ? displayedTweet.attachments.length - 4
                : undefined
            '
          ></MediaView>
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
}

.media-attachments {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  position: relative;
}

.multiple-attachments {
  display: grid;
  gap: 2px;
  position: relative;
  counter-increment: item-counter;
}

.multiple-attachments .img-fluid {
  width: 100%;
  height: 0;
  padding-bottom: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
  overflow: hidden;
  position: relative;
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