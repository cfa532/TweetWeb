import { useTweetStore } from '@/stores'

type FeedPollingResult = {
    feedCandidateIds: string[]
    followingCandidateIds: string[]
}

let timer: ReturnType<typeof setInterval> | null = null
const handlers = new Set<(result: FeedPollingResult) => boolean | void>()

export function startFeedPolling(
    intervalMs = 180_000,
    handler?: (result: FeedPollingResult) => boolean | void
) {
    if (handler) handlers.add(handler)
    const tweetStore = useTweetStore()
    if (timer) {
        return handler ? () => handlers.delete(handler) : undefined
    }
    timer = setInterval(() => {
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
