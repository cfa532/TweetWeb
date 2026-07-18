import { useTweetStore } from '@/stores'

type FeedPollingResult = {
    feedCandidateIds: string[]
    followingCandidateIds: string[]
}

const FEED_POLLING_INTERVAL_MS = 5 * 60 * 1000
const feedPollingSession = {
    timer: null as ReturnType<typeof setInterval> | null,
    hasOpenedMainFeed: false,
}
const handlers = new Set<(result: FeedPollingResult) => boolean | void>()

export function consumeMainFeedOpening(): boolean {
    if (feedPollingSession.hasOpenedMainFeed) return false
    feedPollingSession.hasOpenedMainFeed = true
    return true
}

export function startFeedPolling(
    intervalMs = FEED_POLLING_INTERVAL_MS,
    handler?: (result: FeedPollingResult) => boolean | void
) {
    if (handler) handlers.add(handler)
    const tweetStore = useTweetStore()
    if (feedPollingSession.timer) {
        return handler ? () => handlers.delete(handler) : undefined
    }
    feedPollingSession.timer = setInterval(() => {
        const user = tweetStore.loginUser
        if (user) {
            console.log(`[feedPolling] ${new Date().toLocaleTimeString()} — polling for new tweets`)
            tweetStore.refreshFeedCandidates(10).then(result => {
                let handled = false
                for (const candidateHandler of handlers) {
                    handled = candidateHandler(result) === true || handled
                }
                if (!handled) {
                    tweetStore.replaceFeedPendingCandidates([
                        ...result.feedCandidateIds,
                        ...result.followingCandidateIds,
                    ])
                }
            }).catch(() => {})
        }
    }, intervalMs)
    return handler ? () => handlers.delete(handler) : undefined
}
