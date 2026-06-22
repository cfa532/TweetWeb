<script setup lang="ts">
import { provide, toRef } from 'vue'
import type { ComponentPublicInstance, PropType } from 'vue'
import { TweetView } from '@/views'
import {
    TWEET_MEDIA_ELEMENT_REGISTRY_KEY,
    useTweetMediaLoadingCoordinator,
} from '@/composables/useTweetMediaLoadingCoordinator'

const props = defineProps({
    tweets: { type: Array as PropType<Tweet[]>, required: true },
    isComment: { type: Boolean, default: false },
    parentTweet: { type: Object as PropType<Tweet>, default: undefined },
})

const { setTweetElement, setMediaElement, getMediaLoadState } = useTweetMediaLoadingCoordinator(toRef(props, 'tweets'))
type TweetRowRef = Element | ComponentPublicInstance | null

provide(TWEET_MEDIA_ELEMENT_REGISTRY_KEY, setMediaElement)

const tweetRefCallbacks = new Map<string, (el: TweetRowRef) => void>()

function tweetRefFor(tweet: Tweet) {
    const existing = tweetRefCallbacks.get(tweet.mid)
    if (existing) return existing

    const callback = (el: TweetRowRef) => {
        setTweetElement(tweet, el instanceof Element ? el : null)
    }
    tweetRefCallbacks.set(tweet.mid, callback)
    return callback
}
</script>

<template>
    <div class="feed-container">
        <div
            v-for="tweet in props.tweets"
            :key="tweet.mid"
            :ref="tweetRefFor(tweet)"
            class="tweet-list-row"
        >
            <TweetView
                :tweet="tweet"
                :is-comment="props.isComment"
                :parent-tweet="props.parentTweet"
                :media-load-state-for="(media) => getMediaLoadState(tweet.mid, media)"
            />
        </div>
    </div>
</template>

<style scoped>
.feed-container {
    padding: 4px 0px 0px 0px;
}

.tweet-list-row {
    border: 1px solid #ccc;
    border-radius: 5px;
    margin: 10px 0;
    background-color: #f9f9f9;
    overflow: hidden;
    transition: background-color 0.3s ease;
}

.tweet-list-row:hover {
    background-color: #e9e9e9;
}

.tweet-list-row :deep(.tweet-container.card) {
    border: none;
    margin: 0;
    background-color: transparent;
}
</style>
