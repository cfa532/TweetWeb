import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTweetStore } from './tweetStore'

const existingAttachment: MimeiFileType = {
    mid: 'existing-cid',
    type: 'image/jpeg',
    fileName: 'existing.jpg',
    timestamp: 1,
}

const uploadedAttachment: MimeiFileType = {
    mid: 'uploaded-cid',
    type: 'image/png',
    fileName: 'uploaded.png',
    timestamp: 2,
}

describe('tweetStore.updateTweet attachments', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
        localStorage.clear()
    })

    it('sends the complete attachment list and updates the cached tweet', async () => {
        const runMApp = vi.fn().mockResolvedValue({ success: true, mid: 'tweet-1' })
        const store = useTweetStore()
        store._user = {
            mid: 'user-1',
            username: 'Author',
            hostIds: ['root-1'],
            timestamp: 0,
        }
        store.resolveWritableHostIp = vi.fn().mockResolvedValue('127.0.0.1:9000')
        store.lapi.connectionPool.getConnection = vi.fn().mockResolvedValue({ RunMApp: runMApp })
        store.lapi.connectionPool.releaseConnection = vi.fn()

        const cachedTweet = {
            mid: 'tweet-1',
            authorId: 'user-1',
            author: store._user,
            content: 'Before',
            attachments: [existingAttachment],
            timestamp: 0,
        } as Tweet
        store.tweets.push(cachedTweet)

        await store.updateTweet(
            cachedTweet.mid,
            'After',
            cachedTweet.authorId,
            [uploadedAttachment],
            { downloadable: false, isPrivate: true },
        )

        expect(runMApp).toHaveBeenCalledWith('update_tweet', expect.objectContaining({
            tweetid: 'tweet-1',
            content: 'After',
            attachments: JSON.stringify([uploadedAttachment]),
            downloadable: false,
            isPrivate: true,
        }))
        expect(cachedTweet.content).toBe('After')
        expect(cachedTweet.attachments).toEqual([uploadedAttachment])
        expect(cachedTweet.downloadable).toBe(false)
        expect(cachedTweet.isPrivate).toBe(true)
    })

    it('omits attachments for legacy content-only admin edits', async () => {
        const runMApp = vi.fn().mockResolvedValue({ success: true, mid: 'tweet-2' })
        const store = useTweetStore()
        store._user = {
            mid: 'admin-1',
            username: 'admin',
            hostIds: ['admin-root'],
            timestamp: 0,
        }
        const targetAuthor = {
            mid: 'user-2',
            username: 'Author',
            hostIds: ['root-2'],
            timestamp: 0,
        } as User
        store.getUser = vi.fn().mockResolvedValue(targetAuthor)
        store.resolveWritableHostIp = vi.fn().mockResolvedValue('127.0.0.1:9001')
        store.lapi.connectionPool.getConnection = vi.fn().mockResolvedValue({ RunMApp: runMApp })
        store.lapi.connectionPool.releaseConnection = vi.fn()

        await store.updateTweet('tweet-2', 'Admin edit', targetAuthor.mid)

        expect(runMApp).toHaveBeenCalledWith('update_tweet', expect.not.objectContaining({
            attachments: expect.anything(),
        }))
    })
})
