import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UserAvatar from './UserAvatar.vue'

const user = {
    mid: 'user-1',
    avatar: 'https://example.test/avatar.png',
    hostIds: ['root-host', 'read-host'],
    providerIp: '127.0.0.1:4800',
} as User

describe('UserAvatar', () => {
    it('owns the standardized technical hint', () => {
        const wrapper = mount(UserAvatar, { props: { user } })
        expect(wrapper.attributes('title')).toBe(
            'User ID: user-1\nHost ID: root-host\nBase IP: 127.0.0.1:4800',
        )
        expect(wrapper.attributes('src')).toBe(user.avatar)
    })

    it('supports source overrides and forwards image attributes', () => {
        const wrapper = mount(UserAvatar, {
            props: { user, src: 'blob:preview' },
            attrs: { class: 'profile-avatar', alt: 'Profile avatar', 'data-test': 'avatar' },
        })
        expect(wrapper.attributes('src')).toBe('blob:preview')
        expect(wrapper.classes()).toContain('profile-avatar')
        expect(wrapper.attributes('alt')).toBe('Profile avatar')
        expect(wrapper.attributes('data-test')).toBe('avatar')
    })

    it('uses N/A for unavailable routing values', () => {
        const wrapper = mount(UserAvatar, { props: { user: { mid: 'user-2' } as User } })
        expect(wrapper.attributes('title')).toContain('Host ID: N/A')
        expect(wrapper.attributes('title')).toContain('Base IP: N/A')
    })
})
