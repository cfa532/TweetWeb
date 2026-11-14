import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { storeCredential } from '@/utils/userSession'

// storageCapabilities builds its own probe client through createPooledClient;
// pointing it at a stub keeps the health reply under the test's control.
vi.mock('@/utils/clientProxy', () => ({
    createPooledClient: () => probeClient,
}))

const probeClient: any = { timeout: 0, RunMApp: vi.fn() }

import { useTweetStore } from './tweetStore'

describe('caller sessions on writes', () => {
    beforeEach(() => {
        ;(window as any).hprose = {
            Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
        }
        setActivePinia(createPinia())
        sessionStorage.clear()
        probeClient.RunMApp.mockReset()
    })

    afterEach(() => {
        sessionStorage.clear()
    })

    it('maps each write entry to the account it names', () => {
        const store = useTweetStore()
        const tweet = JSON.stringify({ authorId: 'author-1' })
        const user = JSON.stringify({ mid: 'author-1' })

        expect(store._ownedAccountKey('update_tweet', { appuserid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('delete_comment', { appuserid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('delete_tweet', { userid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('toggle_following', { userid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('add_tweet', { tweet })).toBe('author-1')
        expect(store._ownedAccountKey('add_comment', { comment: tweet })).toBe('author-1')
        expect(store._ownedAccountKey('set_author_core_data', { user })).toBe('author-1')
        // Reads and engagement toggles carry no session.
        expect(store._ownedAccountKey('get_tweet', {})).toBeNull()
        expect(store._ownedAccountKey('toggle_favorite', { appuserid: 'author-1' })).toBeNull()
    })

    it('attaches the session of an account this tab holds a credential for', async () => {
        const store = useTweetStore()
        store.storageCapabilities = vi.fn(async () => ({
            formats: new Set(), userSessions: true, commentDelegation: false, checkedAt: Date.now(),
        })) as any
        storeCredential('author-1', 'alice', 'pw')

        const client = {
            timeout: 0,
            Login: vi.fn().mockResolvedValue({ Sid: 'sid-1', Uid: 'uid-1' }),
            RunMApp: vi.fn().mockResolvedValue({ success: true }),
        }
        const params: Record<string, any> = { userid: 'author-1' }
        await store.runWrite(client, '10.0.0.1:8002', 'delete_tweet', params)

        expect(client.Login).toHaveBeenCalledWith('alice', 'pw')
        expect(params.usersid).toBe('sid-1')
        expect(client.RunMApp).toHaveBeenCalledWith('delete_tweet', params)
    })

    it('writes without a session when this tab holds no credential for the account', async () => {
        const store = useTweetStore()
        store.storageCapabilities = vi.fn(async () => ({
            formats: new Set(), userSessions: true, commentDelegation: false, checkedAt: Date.now(),
        })) as any
        // No storeCredential: an admin acting on another user's data.

        const client = {
            timeout: 0,
            Login: vi.fn(),
            RunMApp: vi.fn().mockResolvedValue({ success: true }),
        }
        const params: Record<string, any> = { appuserid: 'someone-else' }
        await store.runWrite(client, '10.0.0.1:8002', 'update_tweet', params)

        expect(client.Login).not.toHaveBeenCalled()
        expect(params.usersid).toBeUndefined()
    })

    it('re-signs-in once when the node dropped the session', async () => {
        const store = useTweetStore()
        store.storageCapabilities = vi.fn(async () => ({
            formats: new Set(), userSessions: true, commentDelegation: false, checkedAt: Date.now(),
        })) as any
        storeCredential('author-1', 'alice', 'pw')

        const client = {
            timeout: 0,
            Login: vi.fn()
                .mockResolvedValueOnce({ Sid: 'sid-old', Uid: 'uid-1' })
                .mockResolvedValueOnce({ Sid: 'sid-new', Uid: 'uid-1' }),
            RunMApp: vi.fn()
                .mockResolvedValueOnce({ success: false, message: 'Session invalid' })
                .mockResolvedValueOnce({ success: true }),
        }
        const params: Record<string, any> = { userid: 'author-1' }
        const reply = await store.runWrite(client, '10.0.0.2:8002', 'delete_tweet', params)

        expect(reply).toEqual({ success: true })
        expect(client.Login).toHaveBeenCalledTimes(2)
        expect(params.usersid).toBe('sid-new')
        expect(client.RunMApp).toHaveBeenCalledTimes(2)
    })

    it('reads the session flags out of the node health reply', async () => {
        const store = useTweetStore()
        probeClient.RunMApp.mockResolvedValue({
            success: true,
            userSessions: true,
            commentDelegation: true,
            storageFormats: ['database'],
        })

        const capabilities = await store.storageCapabilities('10.0.0.3:8002')

        expect(capabilities.userSessions).toBe(true)
        expect(capabilities.commentDelegation).toBe(true)
        // An older backend reports neither flag; both default to false.
        probeClient.RunMApp.mockResolvedValue({ success: true, storageFormats: ['database'] })
        const legacy = await store.storageCapabilities('10.0.0.4:8002')
        expect(legacy.userSessions).toBe(false)
        expect(legacy.commentDelegation).toBe(false)
    })
})
