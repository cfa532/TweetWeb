import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTweetStore } from './tweetStore'

describe('tweetStore.resyncUser', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
        localStorage.clear()
    })

    it('merges the returned user and tweets into live cache objects', async () => {
        const runMApp = vi.fn().mockResolvedValue({
            user: {
                mid: 'user-1',
                username: 'Updated name',
                hostIds: ['root', 'read'],
            },
            tweets: [{
                mid: 'tweet-1',
                authorId: 'user-1',
                content: 'Synchronized tweet',
                timestamp: 1,
                attachments: [],
            }],
        })
        const user = {
            mid: 'user-1',
            username: 'Old name',
            hostIds: ['root', 'read'],
            providerIp: '127.0.0.1:1234',
            client: { RunMApp: runMApp },
            writableHostIp: null,
        } as unknown as User
        const store = useTweetStore()
        store.users.set(user.mid, user)
        const cachedUser = store.users.get(user.mid)!
        store.getUser = vi.fn().mockResolvedValue(cachedUser)

        const result = await store.resyncUser(user.mid)

        expect(runMApp).toHaveBeenCalledWith('resync_user', expect.objectContaining({
            version: 'v3',
            userid: user.mid,
        }))
        expect(result.user).toBe(cachedUser)
        expect(cachedUser.username).toBe('Updated name')
        expect(result.tweets).toHaveLength(1)
        expect(store.tweetIndex.get('tweet-1')).toBe(result.tweets[0])
        expect(result.tweets[0].author).toBe(cachedUser)
    })

    it('retries on the author providers when the access node does not carry them', async () => {
        const staleRunMApp = vi.fn().mockResolvedValue(null)
        const rootRunMApp = vi.fn().mockResolvedValue({
            user: { mid: 'user-3', username: 'Recovered', hostIds: ['root', 'root'] },
            tweets: [],
        })
        const staleUser = {
            mid: 'user-3',
            username: 'Cached',
            hostIds: ['root', 'stale-access-node'],
            providerIp: '127.0.0.1:1111',
            client: { RunMApp: staleRunMApp },
        } as unknown as User
        const rootUser = {
            mid: 'user-3',
            username: 'Cached',
            hostIds: ['root', 'root'],
            providerIp: '127.0.0.1:2222',
            client: { RunMApp: rootRunMApp },
        } as unknown as User
        const store = useTweetStore()
        store.users.set(staleUser.mid, staleUser)
        localStorage.setItem(staleUser.mid, JSON.stringify({ cachedAt: Date.now(), value: staleUser }))
        store.getUser = vi.fn().mockResolvedValue(staleUser)
        store._getUserForProviderRetryAttempt = vi.fn().mockImplementation(async () => {
            store.users.set(rootUser.mid, rootUser)
            return rootUser
        })

        const result = await store.resyncUser(staleUser.mid)

        expect(staleRunMApp).toHaveBeenCalledTimes(1)
        expect(rootRunMApp).toHaveBeenCalledTimes(1)
        expect(result.user.username).toBe('Recovered')
        // The dead access node is gone from the cache the next reload reads.
        expect(JSON.parse(localStorage.getItem(staleUser.mid)!).value.hostIds)
            .not.toContain('stale-access-node')
    })

    it('reports a failure the access node explains rather than retrying blind', async () => {
        const runMApp = vi.fn().mockResolvedValue({ success: false, message: 'User not found or missing host' })
        const user = {
            mid: 'user-4',
            username: 'Cached',
            hostIds: ['root', 'root'],
            providerIp: '127.0.0.1:1111',
            client: { RunMApp: runMApp },
        } as unknown as User
        const store = useTweetStore()
        store.users.set(user.mid, user)
        store.getUser = vi.fn().mockResolvedValue(user)

        await expect(store.resyncUser(user.mid)).rejects.toThrow('User not found or missing host')
        expect(runMApp).toHaveBeenCalledTimes(1)
    })

    it('uses ordinary get_tweet unless recovery is explicitly forced', async () => {
        const ordinaryRunMApp = vi.fn().mockResolvedValue({
            mid: 'tweet-2',
            authorId: 'user-2',
            content: 'Ordinary read',
            timestamp: 2,
            attachments: [],
        })
        const refreshRunMApp = vi.fn().mockResolvedValue([{
            mid: 'tweet-2',
            authorId: 'user-2',
            content: 'Recovered read',
            timestamp: 2,
            attachments: [],
        }])
        const user = {
            mid: 'user-2',
            username: 'Reader',
            hostIds: ['root', 'read'],
            providerIp: '127.0.0.1:1234',
            client: { RunMApp: refreshRunMApp },
        } as unknown as User
        const store = useTweetStore()
        store.getProviderIp = vi.fn().mockResolvedValue('127.0.0.1:1234')
        store.getUser = vi.fn().mockResolvedValue(user)
        store.lapi.connectionPool.getConnection = vi.fn().mockResolvedValue({ RunMApp: ordinaryRunMApp })
        store.lapi.connectionPool.releaseConnection = vi.fn()

        await store.fetchTweet('tweet-2' as MimeiId, 'user-2' as MimeiId, false, false, true)
        await store.fetchTweet('tweet-2' as MimeiId, 'user-2' as MimeiId, false, true, true)

        expect(ordinaryRunMApp).toHaveBeenCalledWith('get_tweet', expect.any(Object))
        expect(refreshRunMApp).toHaveBeenCalledWith('refresh_tweet', expect.any(Object))
    })

    it('reads a forced fetch from the node and rewrites the cache when read and root nodes match', async () => {
        const ordinaryRunMApp = vi.fn().mockResolvedValue({
            mid: 'tweet-7',
            authorId: 'user-7',
            content: 'Fresh read',
            timestamp: 7,
            attachments: [],
        })
        const rootRunMApp = vi.fn()
        const user = {
            mid: 'user-7',
            username: 'Reader',
            hostIds: ['root', 'root'],
            providerIp: '127.0.0.1:1234',
            client: { RunMApp: rootRunMApp },
        } as unknown as User
        const store = useTweetStore()
        store.getProviderIp = vi.fn().mockResolvedValue('127.0.0.1:1234')
        store.getUser = vi.fn().mockResolvedValue(user)
        store.lapi.connectionPool.getConnection = vi.fn().mockResolvedValue({ RunMApp: ordinaryRunMApp })
        store.lapi.connectionPool.releaseConnection = vi.fn()
        sessionStorage.setItem('tweet-7', JSON.stringify({
            mid: 'tweet-7',
            authorId: 'user-7',
            author: { mid: 'user-7', hostIds: ['root', 'root'] },
            content: 'Stale cached read',
            timestamp: 7,
            attachments: [],
        }))

        const refreshed = await store.fetchTweet('tweet-7' as MimeiId, 'user-7' as MimeiId, false, true, true)

        // An author already reading from its root node needs no refresh_tweet, but the
        // forced fetch must still bypass the cached copy the reload painted.
        expect(rootRunMApp).not.toHaveBeenCalled()
        expect(ordinaryRunMApp).toHaveBeenCalledWith('get_tweet', expect.any(Object))
        expect(refreshed?.content).toBe('Fresh read')
        // The cache is rewritten once the author resolves, so the next reload paints fresh.
        await vi.waitFor(() =>
            expect(JSON.parse(sessionStorage.getItem('tweet-7')!).content).toBe('Fresh read'))
    })
})

describe('tweetStore.loadTweetsByUser access node fallback', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
        localStorage.clear()
    })

    function stubProfileRoutes(store: any, responsesByIp: Record<string, any>) {
        const calls: string[] = []
        store.getUserReadIp = vi.fn().mockImplementation(async (user: User) =>
            user.hostIds?.[1] === 'stale-access-node' ? '127.0.0.1:1111' : '127.0.0.1:2222')
        store.lapi.connectionPool.getConnection = vi.fn().mockImplementation(async (ip: string) => ({
            RunMApp: (_entry: string) => {
                calls.push(ip)
                return Promise.resolve(responsesByIp[ip])
            },
        }))
        store.lapi.connectionPool.releaseConnection = vi.fn()
        return calls
    }

    it('asks the author providers when the access node reports an empty first page', async () => {
        const store = useTweetStore()
        const staleUser = { mid: 'user-5', username: 'Cached', hostIds: ['root', 'stale-access-node'] } as unknown as User
        const rootUser = { mid: 'user-5', username: 'Cached', hostIds: ['root', 'root'] } as unknown as User
        store.users.set(staleUser.mid, staleUser)
        store._getUserForProviderRetryAttempt = vi.fn().mockImplementation(async (_id: string, attempt: number) =>
            attempt === 1 ? staleUser : rootUser)
        const calls = stubProfileRoutes(store, {
            '127.0.0.1:1111': { success: true, tweets: [], originalTweets: [] },
            '127.0.0.1:2222': {
                success: true,
                tweets: [{ mid: 'tweet-5', authorId: 'user-5', content: 'Real', timestamp: 5, attachments: [] }],
                originalTweets: [],
            },
        })

        await expect(store.loadTweetsByUser('user-5', 0, 5)).resolves.toBe(1)
        expect(calls).toEqual(['127.0.0.1:1111', '127.0.0.1:2222'])
    })

    it('accepts an empty first page from the author own root as the end of the timeline', async () => {
        const store = useTweetStore()
        const rootUser = { mid: 'user-6', username: 'Cached', hostIds: ['root', 'root'] } as unknown as User
        store.users.set(rootUser.mid, rootUser)
        store._getUserForProviderRetryAttempt = vi.fn().mockResolvedValue(rootUser)
        const calls = stubProfileRoutes(store, {
            '127.0.0.1:2222': { success: true, tweets: [], originalTweets: [] },
        })

        await expect(store.loadTweetsByUser('user-6', 0, 5)).resolves.toBe(0)
        expect(calls).toEqual(['127.0.0.1:2222'])
    })
})
