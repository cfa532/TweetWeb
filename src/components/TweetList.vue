<script setup lang="ts">
import { onMounted, onUnmounted, provide, ref, toRef } from 'vue'
import type { ComponentPublicInstance, PropType } from 'vue'
import { TweetView } from '@/views'
import { TWEET_LIST_CONTENT_MAX_LINES } from '@/constants'
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

// Floating "back to top" button: only worth showing once the reader has
// scrolled down a bit.
const showScrollTop = ref(false)
function onWindowScroll() {
    showScrollTop.value = window.scrollY > 400
}
function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
}
onMounted(() => window.addEventListener('scroll', onWindowScroll, { passive: true }))
onUnmounted(() => window.removeEventListener('scroll', onWindowScroll))
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
                :max-content-lines="TWEET_LIST_CONTENT_MAX_LINES"
            />
        </div>
    </div>
    <Transition name="scroll-top-fade">
        <button
            v-if="showScrollTop"
            type="button"
            class="scroll-top-button"
            :aria-label="$t('common.scrollToTop')"
            @click="scrollToTop"
        >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 19V5M12 5L5 12M12 5L19 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </button>
    </Transition>
</template>

<style scoped>
.feed-container {
    padding: 0px 0px 0px 0px;
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

.scroll-top-button {
    position: fixed;
    right: calc(18px + env(safe-area-inset-right));
    bottom: calc(18px + env(safe-area-inset-bottom));
    z-index: 1045;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: rgba(29, 155, 240, 0.86);
    color: white;
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.18);
    cursor: pointer;
}

.scroll-top-button:active {
    background: rgba(29, 155, 240, 0.96);
}

@media (max-width: 768px) {
    .scroll-top-button {
        width: 34px;
        height: 34px;
        right: calc(12px + env(safe-area-inset-right));
        bottom: calc(12px + env(safe-area-inset-bottom));
        background: rgba(29, 155, 240, 0.55);
        box-shadow: 0 2px 5px rgba(0, 0, 0, 0.12);
    }
    .scroll-top-button svg {
        width: 16px;
        height: 16px;
    }
}

.scroll-top-fade-enter-active,
.scroll-top-fade-leave-active {
    transition: opacity 0.2s ease, transform 0.2s ease;
}

.scroll-top-fade-enter-from,
.scroll-top-fade-leave-to {
    opacity: 0;
    transform: translateY(8px);
}
</style>
