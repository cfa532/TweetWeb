import { ref, computed } from 'vue'
import { useTweetStore } from '@/stores'

const _displayedFeedIds = ref<Set<string>>(new Set())
const _initialLoadDone = ref(false)

export function useFeedPendingCount() {
  const tweetStore = useTweetStore()

  const feedPendingCount = computed(() => {
    if (!_initialLoadDone.value || !tweetStore.loginUser) return 0
    return tweetStore.tweets.filter(e =>
      tweetStore.feedPendingCandidateIds.has(e.mid) &&
      !_displayedFeedIds.value.has(e.mid) &&
      !e.isPrivate &&
      (!e.originalTweetId || e.originalTweet !== null)
    ).length
  })

  const pendingFeedAuthors = computed(() => {
    if (!_initialLoadDone.value || !tweetStore.loginUser) return []
    const seen = new Set<string>()
    const authors: any[] = []
    for (const e of tweetStore.tweets) {
      if (!tweetStore.feedPendingCandidateIds.has(e.mid)) continue
      if (_displayedFeedIds.value.has(e.mid)) continue
      if (e.isPrivate || (e.originalTweetId && !e.originalTweet)) continue
      const author = e.author as any
      if (author && !seen.has(author.mid)) {
        seen.add(author.mid)
        authors.push(author)
        if (authors.length >= 3) break
      }
    }
    return authors
  })

  function syncFeedDisplayed(tweets: { mid: string; timestamp?: string | number }[], initialDone: boolean) {
    _displayedFeedIds.value = new Set(tweets.map(t => t.mid))
    _initialLoadDone.value = initialDone
  }

  return { feedPendingCount, pendingFeedAuthors, syncFeedDisplayed }
}
