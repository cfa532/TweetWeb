import { ref, computed } from 'vue'
import { useTweetStore } from '@/stores'

// Module-level: survives component re-renders and is shared across all components.
const _displayedFeedIds = ref<Set<string>>(new Set())
const _initialLoadDone = ref(false)

export function useFeedPendingCount() {
  const tweetStore = useTweetStore()

  const feedPendingCount = computed(() => {
    if (!_initialLoadDone.value || !tweetStore.loginUser) return 0
    // Only count main-feed tweets — `tweetStore.tweets` is a shared cache that profile
    // and pinned loaders also populate, so without this guard tweets viewed on a profile
    // would inflate the "new on main feed" count.
    return tweetStore.tweets.filter(e =>
      tweetStore.feedTweetIds.has(e.mid) &&
      !_displayedFeedIds.value.has(e.mid) &&
      !e.isPrivate &&
      (!e.originalTweetId || e.originalTweet !== null)
    ).length
  })

  function syncFeedDisplayed(tweets: { mid: string }[], initialDone: boolean) {
    _displayedFeedIds.value = new Set(tweets.map(t => t.mid))
    _initialLoadDone.value = initialDone
  }

  return { feedPendingCount, syncFeedDisplayed }
}
