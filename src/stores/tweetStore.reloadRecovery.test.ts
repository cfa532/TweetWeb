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
})
