import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTweetStore } from './tweetStore'

const tweet = (favorites: boolean[]): Tweet => ({
    mid: 'comment-1',
    authorId: 'comment-author',
    author: { mid: 'comment-author', username: 'Commenter', timestamp: 0 },
    timestamp: 0,
    favorites,
})

describe('tweetStore interaction state', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
    })

    it('applies explicit overrides over stale payload flags', () => {
        const store = useTweetStore()
        store.interactionOverrides.set('comment-1', { favorite: true, bookmark: false })

        expect(store.resolvedInteractionFlags(tweet([false, true, true]))).toEqual([
            true,
            false,
            true,
        ])
    })

    it('updates one override without discarding the other', () => {
        const store = useTweetStore()
        store.interactionOverrides.set('comment-1', { bookmark: true })

        store.setInteractionOverride('comment-1', 'favorite', false)

        expect(store.interactionOverrides.get('comment-1')).toEqual({
            favorite: false,
            bookmark: true,
        })
    })
})
