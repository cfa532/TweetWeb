import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTweetStore } from './tweetStore'

const TWEET_PROVIDER = '220.184.34.132:8002'

/**
 * Answers get_comments with the given comments, and get_user with nothing — the
 * case where the tweet's own node does not carry the commenter's record, so
 * author decoration has to fall through to the commenter's own provider.
 */
function stubTweetProvider(store: any, ...comments: Record<string, unknown>[]) {
    vi.spyOn(store.lapi.connectionPool, 'getConnection').mockResolvedValue({
        RunMApp: async (method: string) => (method === 'get_comments' ? comments : null),
    } as any)
    vi.spyOn(store.lapi.connectionPool, 'releaseConnection').mockImplementation(() => {})
}

/** Let the detached author-decoration IIFEs settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('comment author decoration', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
    })

    it('forces fresh discovery when the first author lookup comes back empty', async () => {
        const store = useTweetStore()
        const authorId = 'commenter-behind-a-stale-route'
        const author = { mid: authorId, username: 'Commenter', timestamp: 0, hostIds: ['host-1'] }
        stubTweetProvider(store, { mid: 'comment-1', authorId, content: 'hi', timestamp: 1 })

        // Attempt 1 answers from cached routing and finds nothing — a fetch
        // cooldown or a stored user whose route no longer resolves. Attempt 2
        // invalidates that and succeeds.
        const attempts: number[] = []
        store._getUserForProviderRetryAttempt = vi.fn(async (_mid: string, attempt: number) => {
            attempts.push(attempt)
            return attempt >= 2 ? author : undefined
        }) as any

        const tweet: any = { mid: 'tweet-1', provider: TWEET_PROVIDER, comments: [] }
        await store.loadComments(tweet)
        await flush()

        expect(attempts).toEqual([1, 2])
        // Without the second pass the header renders "loading author" forever:
        // nothing else retries, and with no avatar there is no error hook.
        expect(tweet.comments[0].author).toEqual(author)
    })

    it('skips a provider that has no record and takes the one that does', async () => {
        const store = useTweetStore()
        const userId = 'commenter-missing-from-one-node'
        const emptyIp = '220.0.0.1:8002'
        const holdingIp = '220.184.34.132:8002'
        const record = { mid: userId, username: 'Commenter', hostIds: ['host-1'], timestamp: 0 }

        store.getProviderIps = vi.fn(async () => [emptyIp, holdingIp]) as any
        vi.spyOn(store.lapi.connectionPool, 'getConnection').mockImplementation(async (ip: string) => ({
            // A node holding no local copy answers NOT_LOCAL; a node running a
            // build without the response envelope answers a bare null for the
            // same thing. Either way it means "not mine", not "no such user",
            // and neither may beat the node that has the record.
            RunMApp: async () => (ip === emptyIp ? null : record),
        }) as any)
        vi.spyOn(store.lapi.connectionPool, 'releaseConnection').mockImplementation(() => {})

        const user = await store._fetchUser(userId, true)

        expect(user?.mid).toBe(userId)
        // The empty answer must not poison the retry budget either.
        expect(store._resourceFetchFailures.get(userId)).toBeUndefined()
    })

    it('stops at the first pass when it resolves the author', async () => {
        const store = useTweetStore()
        const authorId = 'reachable-commenter'
        const author = { mid: authorId, username: 'Commenter', timestamp: 0, hostIds: ['host-1'] }
        stubTweetProvider(store, { mid: 'comment-1', authorId, content: 'hi', timestamp: 1 })

        const attempts: number[] = []
        store._getUserForProviderRetryAttempt = vi.fn(async (_mid: string, attempt: number) => {
            attempts.push(attempt)
            return author
        }) as any

        const tweet: any = { mid: 'tweet-1', provider: TWEET_PROVIDER, comments: [] }
        await store.loadComments(tweet)
        await flush()

        // No needless second round trip, and no cache invalidation, for an
        // author the cheap pass already found.
        expect(attempts).toEqual([1])
        expect(tweet.comments[0].author).toEqual(author)
    })

    it('looks an author up once for a page of their comments', async () => {
        const store = useTweetStore()
        const authorId = 'prolific-commenter'
        const author = { mid: authorId, username: 'Commenter', timestamp: 0, hostIds: ['host-1'] }
        stubTweetProvider(
            store,
            ...Array.from({ length: 6 }, (_, i) => ({
                mid: `comment-${i}`, authorId, content: 'hi', timestamp: i,
            })),
        )

        const lookups: string[] = []
        store._getUserForProviderRetryAttempt = vi.fn(async (mid: string) => {
            lookups.push(mid)
            return author
        }) as any

        const tweet: any = { mid: 'tweet-1', provider: TWEET_PROVIDER, comments: [] }
        await store.loadComments(tweet)
        await flush()

        // One lookup per distinct author, not per comment. Per-comment fan-out
        // opened more concurrent RPCs than the connection pool allows per IP, so
        // the surplus queued behind a 15s connect timeout.
        expect(lookups).toEqual([authorId])
        expect(tweet.comments).toHaveLength(6)
        for (const comment of tweet.comments) {
            expect(comment.author).toEqual(author)
        }
    })
})
