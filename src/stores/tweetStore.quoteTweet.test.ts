import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isCommentTweet } from '@/lib'
import { useTweetStore } from './tweetStore'

const PARENT_ID = 'parent-tweet'

describe('quote tweets stay in tweet lists', () => {
    it('treats only a parent with nothing quoted as a comment', () => {
        // A quote tweet carries both references and belongs in the list.
        expect(isCommentTweet({ parentTweetId: PARENT_ID, originalTweetId: PARENT_ID })).toBe(false)
        // A plain comment lives under its parent.
        expect(isCommentTweet({ parentTweetId: PARENT_ID, originalTweetId: undefined })).toBe(true)
        // A retweet and an ordinary tweet are both list rows.
        expect(isCommentTweet({ parentTweetId: undefined, originalTweetId: PARENT_ID })).toBe(false)
        expect(isCommentTweet({ parentTweetId: undefined, originalTweetId: undefined })).toBe(false)
    })
})

describe('uploadTweet comment payload', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
    })

    it('sends the parent to the backend without mutating the caller payload', async () => {
        const store = useTweetStore()
        const author = { mid: 'parent-author', username: 'Parent', timestamp: 0, hostIds: ['host-1'] }
        store._user = { mid: 'me', username: 'Me', timestamp: 0, hostIds: ['host-me'] } as any
        store.getTweet = vi.fn().mockResolvedValue({ mid: PARENT_ID, authorId: author.mid, author, timestamp: 0 }) as any
        store.getUser = vi.fn().mockResolvedValue(author) as any
        store.resolveWritableHostIp = vi.fn().mockResolvedValue('220.184.34.132:8002') as any

        const sent: any[] = []
        vi.spyOn(store.lapi.connectionPool, 'getConnection').mockResolvedValue({
            RunMApp: async (_method: string, params: any) => {
                sent.push(params)
                return { success: true, mid: 'comment-mid' }
            },
        } as any)
        vi.spyOn(store.lapi.connectionPool, 'releaseConnection').mockImplementation(() => {})

        const payload: any = { authorId: 'me', content: 'a comment', timestamp: 1 }
        await store.uploadTweet(payload, PARENT_ID)

        expect(JSON.parse(sent[0].comment).parentTweetId).toBe(PARENT_ID)
        // The editor reuses this object to publish the quote tweet, which sets
        // its own references — an implicit stamp here would be a surprise.
        expect(payload.parentTweetId).toBeUndefined()
    })
})
