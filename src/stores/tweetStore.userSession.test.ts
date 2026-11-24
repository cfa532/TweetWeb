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

// A session is opened only on the account's own root, which the store learns by
// resolving the account's write route.
async function rootAccountAt(store: any, mid: string, ip: string) {
    store.getNodeIp = vi.fn(async () => ip)
    await store.resolveWritableHostIp({ mid, hostIds: ['root-host'] })
}

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
        expect(store._ownedAccountKey('toggle_favorite', { appuserid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('retweet_added', { appuserid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('delete_tweet', { userid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('toggle_bookmark', { userid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('toggle_following', { userid: 'author-1' })).toBe('author-1')
        expect(store._ownedAccountKey('add_tweet', { tweet })).toBe('author-1')
        expect(store._ownedAccountKey('add_comment', { comment: tweet })).toBe('author-1')
        expect(store._ownedAccountKey('set_author_core_data', { user })).toBe('author-1')
        // Reads carry no session.
        expect(store._ownedAccountKey('get_tweet', {})).toBeNull()
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
        await rootAccountAt(store, 'author-1', '10.0.0.1:8002')
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

    it('does not sign in at a node that is not the account\'s root', async () => {
        const store = useTweetStore()
        store.storageCapabilities = vi.fn(async () => ({
            formats: new Set(), userSessions: true, commentDelegation: false, checkedAt: Date.now(),
        })) as any
        storeCredential('author-9', 'alice', 'pw')
        await rootAccountAt(store, 'author-9', '10.0.0.9:8002')

        // A like sent in the old form goes to the tweet author's node: the
        // password must not follow it there.
        const client = {
            timeout: 0,
            Login: vi.fn().mockResolvedValue({ Sid: 'sid-x', Uid: 'uid-x' }),
            RunMApp: vi.fn().mockResolvedValue({ success: true }),
        }
        const params: Record<string, any> = { appuserid: 'author-9' }
        await store.runWrite(client, '10.0.0.77:8002', 'toggle_favorite', params)

        expect(client.Login).not.toHaveBeenCalled()
        expect(params.usersid).toBeUndefined()
        expect(client.RunMApp).toHaveBeenCalledWith('toggle_favorite', params)
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
        await rootAccountAt(store, 'author-1', '10.0.0.2:8002')
        const reply = await store.runWrite(client, '10.0.0.2:8002', 'delete_tweet', params)

        expect(reply).toEqual({ success: true })
        expect(client.Login).toHaveBeenCalledTimes(2)
        expect(params.usersid).toBe('sid-new')
        expect(client.RunMApp).toHaveBeenCalledTimes(2)
    })

    // A legacy account: Leither on its root has no guest for it yet.
    async function legacyLoginStore(bindReply: any, mid = 'legacy-1') {
        const store = useTweetStore()
        store.storageCapabilities = vi.fn(async () => ({
            formats: new Set(), userSessions: true, commentDelegation: false, checkedAt: Date.now(),
        })) as any
        store.lapi.client = { RunMApp: vi.fn().mockResolvedValue(mid) } as any
        store.getUser = vi.fn(async () => ({ mid, providerIp: '10.0.0.5:8002', hostIds: ['root-host'] })) as any
        await rootAccountAt(store, mid, '10.0.0.5:8002')
        store.addFollowing = vi.fn() as any
        probeClient.Login = vi.fn()
            .mockRejectedValueOnce(new Error('1102:login info error'))
            .mockResolvedValueOnce({ Sid: 'guest-sid', Uid: 'guest-uid' })
        probeClient.Register = vi.fn().mockResolvedValue('guest-uid')
        probeClient.RunMApp = vi.fn()
            .mockResolvedValueOnce({ success: true, status: 'success' })
            .mockResolvedValueOnce(bindReply)
        return store
    }

    it('registers a Leither guest for a legacy account once its password is verified', async () => {
        const store = await legacyLoginStore({ success: true, status: 'success' })

        await store.login('dom', 'pw')

        expect(probeClient.Register).toHaveBeenCalledWith('dom', 'pw', '')
        const [first, second] = probeClient.RunMApp.mock.calls
        expect(first[1].usersid).toBeUndefined()
        expect(second[0]).toBe('login')
        expect(second[1]).toMatchObject({ username: 'dom', password: 'pw', usersid: 'guest-sid' })
        // Writes from this tab now carry the bound guest's session.
        const client = { timeout: 0, Login: vi.fn(), RunMApp: vi.fn().mockResolvedValue({ success: true }) }
        const params: Record<string, any> = { userid: 'legacy-1' }
        await store.runWrite(client, '10.0.0.5:8002', 'delete_tweet', params)
        expect(client.Login).not.toHaveBeenCalled()
        expect(params.usersid).toBe('guest-sid')
    })

    it('keeps the login when the root refuses to bind the legacy account', async () => {
        const store = await legacyLoginStore({ success: false, message: 'Wrong password' })

        const user = await store.login('dom', 'pw')

        expect(user?.mid).toBe('legacy-1')
        expect(probeClient.RunMApp).toHaveBeenCalledTimes(2)
    })

    it('does not retry the guest sign-in on writes when Leither refused it at login', async () => {
        // Its own account: sessions opened by earlier tests stay in the module.
        const store = await legacyLoginStore(undefined, 'unbindable-1')
        // The name is taken in Leither by someone else: neither sign-in works.
        probeClient.Register = vi.fn().mockRejectedValue(new Error('name exists'))
        probeClient.Login = vi.fn().mockRejectedValue(new Error('1102:login info error'))

        await store.login('gen8', 'pw')

        const client = { timeout: 0, Login: vi.fn(), RunMApp: vi.fn().mockResolvedValue({ success: true }) }
        const params: Record<string, any> = { userid: 'unbindable-1' }
        await store.runWrite(client, '10.0.0.5:8002', 'delete_tweet', params)
        expect(client.Login).not.toHaveBeenCalled()
        expect(params.usersid).toBeUndefined()
    })

    it('does not register a guest when the app login fails', async () => {
        const store = await legacyLoginStore(undefined)
        probeClient.RunMApp = vi.fn().mockResolvedValue({ success: false, message: 'Wrong password' })

        await expect(store.login('dom', 'typo')).rejects.toThrow()

        expect(probeClient.Register).not.toHaveBeenCalled()
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
