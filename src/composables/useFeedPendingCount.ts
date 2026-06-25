import { ref, computed } from 'vue'
import { useTweetStore } from '@/stores'

const _displayedFeedIds = ref<Set<string>>(new Set())
const _initialLoadDone = ref(false)
const _topFeedTimestamp = ref(0)

export function useFeedPendingCount() {
  const tweetStore = useTweetStore()

  const feedPendingCount = computed(() => {
    if (!_initialLoadDone.value || !tweetStore.loginUser) return 0
    const top = _topFeedTimestamp.value
    return tweetStore.tweets.filter(e =>
      tweetStore.feedTweetIds.has(e.mid) &&
      !_displayedFeedIds.value.has(e.mid) &&
      !e.isPrivate &&
      (!e.originalTweetId || e.originalTweet !== null) &&
      (e.timestamp as number) > top
    ).length
  })

  const pendingFeedAuthors = computed(() => {
    if (!_initialLoadDone.value || !tweetStore.loginUser) return []
    const top = _topFeedTimestamp.value
    const seen = new Set<string>()
    const authors: any[] = []
    for (const e of tweetStore.tweets) {
      if (!tweetStore.feedTweetIds.has(e.mid)) continue
      if (_displayedFeedIds.value.has(e.mid)) continue
      if (e.isPrivate || (e.originalTweetId && !e.originalTweet)) continue
      if ((e.timestamp as number) <= top) continue
      const author = e.author as any
      if (author && !seen.has(author.mid)) {
        seen.add(author.mid)
        authors.push(author)
        if (authors.length >= 3) break
      }
    }
    return authors
  })

  function syncFeedDisplayed(tweets: { mid: string; timestamp?: number }[], initialDone: boolean) {
    _displayedFeedIds.value = new Set(tweets.map(t => t.mid))
    _initialLoadDone.value = initialDone
    _topFeedTimestamp.value = tweets.length > 0 ? ((tweets[0] as any).timestamp as number ?? 0) : 0
  }

  return { feedPendingCount, pendingFeedAuthors, syncFeedDisplayed }
}
