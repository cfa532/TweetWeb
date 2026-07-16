import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useTweetStore } from '@/stores'
import TweetActionBar from './TweetActionBar.vue'

vi.mock('vue-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
    useRoute: () => ({ fullPath: '/tweet/parent' }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
    const actual = await importOriginal<typeof import('vue-i18n')>()
    return {
        ...actual,
        useI18n: () => ({ t: (key: string) => key }),
    }
})

const loginUser = {
    mid: 'login-user',
    username: 'Login user',
    hostIds: ['root-host'],
    timestamp: 0,
} as User

const comment = {
    mid: 'comment-1',
    authorId: 'comment-author',
    author: { mid: 'comment-author', username: 'Commenter', timestamp: 0 },
    timestamp: 0,
    favorites: [false, false, false],
} as Tweet

describe('TweetActionBar interaction state', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
    })

    it('renders and toggles from the authoritative favorite override', async () => {
        const store = useTweetStore()
        store.$patch({ _user: loginUser })
        store.interactionOverrides.set(comment.mid, { favorite: true })
        store.toggleFavorite = vi.fn().mockResolvedValue({
            ...comment,
            favorites: [false, false, false],
            favoriteOverride: false,
        })

        const wrapper = mount(TweetActionBar, {
            props: { tweet: comment },
            global: {
                mocks: { $t: (key: string) => key },
                stubs: { FontAwesomeIcon: true },
            },
        })
        const favoriteButton = wrapper.findAll('button.action-btn')[2]

        expect(favoriteButton.classes()).toContain('action-liked')

        await favoriteButton.trigger('click')
        await flushPromises()

        expect(store.toggleFavorite).toHaveBeenCalledWith(expect.objectContaining({
            mid: comment.mid,
            favorites: [true, false, false],
        }), false)
    })
})
