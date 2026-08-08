import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useTweetStore } from '@/stores'
import DetailHeader from './DetailHeader.vue'

vi.mock('vue-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
    useRoute: () => ({ fullPath: '/tweet/comment-1/author-1' }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
    const actual = await importOriginal<typeof import('vue-i18n')>()
    return {
        ...actual,
        useI18n: () => ({ t: (key: string) => key }),
    }
})

const comment = {
    mid: 'comment-1',
    authorId: 'author-1',
    timestamp: 0,
} as Tweet

function mountHeader(author: User | null = null) {
    return mount(DetailHeader, {
        props: { author, authorId: 'author-1', tweet: comment, timestamp: 1, isComment: true },
        global: {
            mocks: { $t: (key: string) => key },
            stubs: { CornerMenu: true, FontAwesomeIcon: true },
        },
    })
}

describe('DetailHeader with an unresolved author', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
    })

    it('shows a placeholder and attempts one author fetch', async () => {
        const store = useTweetStore()
        store.getUser = vi.fn().mockResolvedValue(undefined)
        store.getCachedUserTweets = vi.fn().mockReturnValue([])

        const wrapper = mountHeader()
        await flushPromises()

        expect(wrapper.find('.placeholder-avatar').exists()).toBe(true)
        expect(wrapper.find('.username').text()).toBe('tweet.loadingAuthor')
        expect(wrapper.find('.alias').text()).toBe('@tweet.loadingUsername')
        expect(store.getUser).toHaveBeenCalledWith('author-1')
        expect(store.getUser).toHaveBeenCalledTimes(1)
    })

    it('renders the cached author once it lands in the store', async () => {
        const store = useTweetStore()
        store.getUser = vi.fn().mockResolvedValue(undefined)
        store.getCachedUserTweets = vi.fn().mockReturnValue([])
        store.users.set('author-1', { mid: 'author-1', name: 'Commenter', username: 'commenter' } as User)

        const wrapper = mountHeader()
        await flushPromises()

        expect(wrapper.find('.placeholder-avatar').exists()).toBe(false)
        expect(wrapper.find('.username').text()).toBe('Commenter')
        expect(wrapper.find('.alias').text()).toBe('@commenter')
        expect(store.getUser).not.toHaveBeenCalled()
    })
})
