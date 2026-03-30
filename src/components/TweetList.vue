<script setup lang="ts">
import type { PropType } from 'vue'
import { TweetView } from '@/views'

const props = defineProps({
    tweets: { type: Array as PropType<Tweet[]>, required: true },
    isComment: { type: Boolean, default: false },
    parentTweet: { type: Object as PropType<Tweet>, default: undefined },
})
</script>

<template>
    <TweetView
        v-for="tweet in props.tweets"
        :key="tweet.mid"
        :tweet="tweet"
        :is-comment="props.isComment"
        :parent-tweet="props.parentTweet"
    />
</template>
