import { useTweetStore } from '@/stores'

let timer: ReturnType<typeof setInterval> | null = null

export function startFeedPolling(intervalMs = 180_000) {
    if (timer) return
    const tweetStore = useTweetStore()
    timer = setInterval(() => {
        const user = tweetStore.loginUser
        if (user) {
            // Poll via get_tweet_feed (page 0) so we pick up tweets the server
            // already has in the feed — update_following_tweets returns 0 because
            // the server-side sync already ran during initial load.
            tweetStore.getTweetFeed(user, 0, 10).catch(() => {})
        }
    }, intervalMs)
}
