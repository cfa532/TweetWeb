import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, isReactive } from 'vue'
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

    it.each([
        { reply: null, error: 'No response from resync_user' },
        { reply: { success: false, message: 'Synchronization failed' }, error: 'Synchronization failed' },
    ])('preserves the login route when resync reports $error', async ({ reply, error }) => {
        const runMApp = vi.fn().mockResolvedValue(reply)
        const user = {
            mid: 'user-3',
            username: 'Cached',
            hostIds: ['root', 'access-node'],
            providerIp: '127.0.0.1:1111',
            client: { RunMApp: runMApp },
        } as unknown as User
        const store = useTweetStore()
        store.users.set(user.mid, user)
        store._user = store.users.get(user.mid)!
        const loginUser = store.loginUser!
        const client = loginUser.client
        localStorage.setItem(user.mid, JSON.stringify({ cachedAt: Date.now(), value: user }))
        const persisted = localStorage.getItem(user.mid)
        store.getUser = vi.fn().mockResolvedValue(loginUser)
        store._getUserForProviderRetryAttempt = vi.fn()

        await expect(store.resyncUser(user.mid)).rejects.toThrow(error)

        expect(runMApp).toHaveBeenCalledTimes(1)
        expect(store._getUserForProviderRetryAttempt).not.toHaveBeenCalled()
        expect(store.loginUser).toBe(loginUser)
        expect(loginUser.hostIds).toEqual(['root', 'access-node'])
        expect(loginUser.providerIp).toBe('127.0.0.1:1111')
        expect(loginUser.client).toBe(client)
        expect(localStorage.getItem(user.mid)).toBe(persisted)
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

        await store.fetchTweet('tweet-2' as MimeiId, 'user-2' as MimeiId, false, true)
        await store.fetchTweet('tweet-2' as MimeiId, 'user-2' as MimeiId, true, true)

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

        const refreshed = await store.fetchTweet('tweet-7' as MimeiId, 'user-7' as MimeiId, true, true)

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

describe('tweetStore.loadTweetsByUser route preservation', () => {
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

    it('preserves the login route when an access node reports an empty first page', async () => {
        const store = useTweetStore()
        const user = {
            mid: 'user-5', username: 'Cached', hostIds: ['root', 'stale-access-node'],
            providerIp: '127.0.0.1:1111', client: {},
        } as unknown as User
        store.users.set(user.mid, user)
        store._user = store.users.get(user.mid)!
        const loginUser = store.loginUser!
        store._getUserForProviderRetryAttempt = vi.fn().mockResolvedValue(loginUser)
        const calls = stubProfileRoutes(store, {
            '127.0.0.1:1111': { success: true, tweets: [], originalTweets: [] },
        })

        await expect(store.loadTweetsByUser('user-5', 0, 5)).resolves.toBe(0)
        expect(calls).toEqual(['127.0.0.1:1111'])
        expect(store._getUserForProviderRetryAttempt).toHaveBeenCalledTimes(1)
        expect(store.loginUser).toBe(loginUser)
        expect(loginUser.hostIds).toEqual(['root', 'stale-access-node'])
        expect(loginUser.providerIp).toBe('127.0.0.1:1111')
        expect(loginUser.client).toBeDefined()
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

describe('restored login user reactivity', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        sessionStorage.clear()
        localStorage.clear()
    })

    it('updates an avatar tooltip when the restored user receives its read route', () => {
        sessionStorage.setItem('user', JSON.stringify({ mid: 'restored-login-user', username: 'Cached' }))
        const store = useTweetStore()
        const restored = store.loginUser!
        const tooltip = computed(() => restored.providerIp ?? 'N/A')

        expect(tooltip.value).toBe('N/A')
        expect(isReactive(restored)).toBe(true)
        expect(restored).toBe(store._user)
        expect(restored).toBe(store.users.get(restored.mid))

        store._user!.providerIp = '127.0.0.1:1234'
        expect(tooltip.value).toBe('127.0.0.1:1234')
    })
})
