import { useTweetStore } from '@/stores'

let timer: ReturnType<typeof setInterval> | null = null

export function startFeedPolling(intervalMs = 180_000) {
    if (timer) return
    const tweetStore = useTweetStore()
    timer = setInterval(() => {
        const user = tweetStore.loginUser
        if (user) {
            console.log(`[feedPolling] ${new Date().toLocaleTimeString()} — polling for new tweets`)
            tweetStore.refreshFeedPendingCandidates(10).catch(() => {})
        }
    }, intervalMs)
}
