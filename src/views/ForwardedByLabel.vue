<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTweetStore } from '@/stores';

const props = defineProps<{ tweet: Tweet }>();
const { t } = useI18n();
const tweetStore = useTweetStore();
const forwardedBy = computed(() => props.tweet.authorId === tweetStore.loginUser?.mid
  ? t('tweet.forwardedByYou')
  : t('tweet.forwardedBy', { name: props.tweet.author?.username || props.tweet.authorId }));
</script>

<template>
  <p class="forwarded-by">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 14V9a3 3 0 0 1 3-3h13m-4-4 4 4-4 4M20 10v5a3 3 0 0 1-3 3H4m4-4-4 4 4 4" />
    </svg>
    <span>{{ forwardedBy }}</span>
  </p>
</template>

<style scoped>
.forwarded-by {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 6px 12px 0;
  color: #536471;
  font-size: 0.8rem;
}

.forwarded-by svg {
  flex: none;
  width: 1em;
  height: 1em;
}
</style>
