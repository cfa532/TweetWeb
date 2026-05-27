<script setup lang="ts">
import { toRef } from 'vue'
import type { PropType } from 'vue'
import { TweetView } from '@/views'
import { useTweetMediaLoadingCoordinator } from '@/composables/useTweetMediaLoadingCoordinator'

const props = defineProps({
    tweets: { type: Array as PropType<Tweet[]>, required: true },
    isComment: { type: Boolean, default: false },
    parentTweet: { type: Object as PropType<Tweet>, default: undefined },
})

const { setTweetElement, getMediaLoadState } = useTweetMediaLoadingCoordinator(toRef(props, 'tweets'))
</script>

<template>
    <div
        v-for="tweet in props.tweets"
        :key="tweet.mid"
        :ref="(el) => setTweetElement(tweet, el as Element | null)"
        class="tweet-list-row"
    >
        <TweetView
            :tweet="tweet"
            :is-comment="props.isComment"
            :parent-tweet="props.parentTweet"
            :media-load-state-for="(media) => getMediaLoadState(tweet.mid, media)"
        />
    </div>
</template>
