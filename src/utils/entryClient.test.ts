import { describe, expect, it, vi } from 'vitest'
import { createEntryClient } from './entryClient'

type Responder = (method: string, args: any[]) => any

/** Stands in for the hprose clients the store builds per address. */
function fakeNodes(responders: Record<string, Responder>) {
    const calls: string[] = []
    const createClient = (address: string) => new Proxy({} as any, {
        get(_target, prop) {
            if (prop === 'timeout') return 0
            return (...args: any[]) => {
                calls.push(`${address}:${String(prop)}`)
                return Promise.resolve(responders[address](String(prop), args))
            }
        },
        set() { return true },
    })
    return { createClient, calls }
}

const down = () => { throw new Error('connection refused') }

describe('entry client failover', () => {
    it('moves to the next node when a call fails', async () => {
        const { createClient, calls } = fakeNodes({
            'a:80': down,
            'b:80': () => 'from b',
        })
        const client = createEntryClient({ routes: ['a:80', 'b:80'], createClient })

        await expect(client.RunMApp('get_provider_ips', {})).resolves.toBe('from b')
        expect(calls).toEqual(['a:80:RunMApp', 'b:80:RunMApp'])
    })

    it('stays on the node that answered instead of returning to the dead one', async () => {
        const { createClient, calls } = fakeNodes({
            'a:80': down,
            'b:80': () => 'from b',
        })
        const client = createEntryClient({ routes: ['a:80', 'b:80'], createClient })

        await client.RunMApp('get_provider_ips', {})
        calls.length = 0
        await client.RunMApp('get_node_ips', {})

        expect(calls).toEqual(['b:80:RunMApp'])
        expect(client.ip).toBe('b:80')
    })

    it('does not rotate on a null answer — that is a healthy node saying "no"', async () => {
        const { createClient, calls } = fakeNodes({
            'a:80': () => null,
            'b:80': () => 'from b',
        })
        const client = createEntryClient({ routes: ['a:80', 'b:80'], createClient })

        await expect(client.RunMApp('get_provider_ips', {})).resolves.toBeNull()
        await client.RunMApp('get_provider_ips', {})

        expect(calls).toEqual(['a:80:RunMApp', 'a:80:RunMApp'])
    })

    it('gives up after MAX_ENTRY_ROUTE_ATTEMPTS nodes and reports the last error', async () => {
        const { createClient, calls } = fakeNodes({
            'a:80': down, 'b:80': down, 'c:80': down, 'd:80': down,
        })
        const client = createEntryClient({ routes: ['a:80', 'b:80', 'c:80', 'd:80'], createClient })

        await expect(client.RunMApp('get_provider_ips', {})).rejects.toThrow('connection refused')
        expect(calls).toEqual(['a:80:RunMApp', 'b:80:RunMApp', 'c:80:RunMApp'])
    })

    it('advances one node for a burst of concurrent calls, not one per call', async () => {
        const { createClient, calls } = fakeNodes({
            'a:80': down,
            'b:80': () => 'from b',
            'c:80': () => 'from c',
        })
        const client = createEntryClient({ routes: ['a:80', 'b:80', 'c:80'], createClient })

        const results = await Promise.all([
            client.RunMApp('one', {}),
            client.RunMApp('two', {}),
            client.RunMApp('three', {}),
        ])

        // Every call falls over to b — none of them skips past it to c because
        // a sibling had already moved the pointer.
        expect(results).toEqual(['from b', 'from b', 'from b'])
        expect(calls.filter(call => call.startsWith('c:80'))).toEqual([])
    })

    it('carries a caller-set timeout onto whichever node serves the call', async () => {
        const timeouts: Record<string, number> = {}
        const createClient = (address: string) => ({
            set timeout(value: number) { timeouts[address] = value },
            get timeout() { return timeouts[address] },
            RunMApp: async () => (address === 'a:80' ? down() : 'from b'),
        })
        const client = createEntryClient({ routes: ['a:80', 'b:80'], createClient })

        client.timeout = 30000
        expect(client.timeout).toBe(30000)
        await client.RunMApp('register', {})

        expect(timeouts).toEqual({ 'a:80': 30000, 'b:80': 30000 })
    })

    it('reuses one underlying client per address', async () => {
        const createClient = vi.fn((address: string) => ({
            timeout: 0,
            RunMApp: async () => address,
        }))
        const client = createEntryClient({ routes: ['a:80', 'b:80'], createClient })

        await client.RunMApp('one', {})
        await client.RunMApp('two', {})

        expect(createClient).toHaveBeenCalledTimes(1)
    })

    it('refuses to exist without a route rather than pointing at nothing', () => {
        expect(() => createEntryClient({ routes: [], createClient: () => ({}) })).toThrow()
        expect(() => createEntryClient({ routes: ['  '], createClient: () => ({}) })).toThrow()
    })

    it('does not masquerade as a thenable or a Vue ref', () => {
        const client = createEntryClient({ routes: ['a:80'], createClient: () => ({}) })
        expect(client.then).toBeUndefined()
        expect(client.__v_isRef).toBeUndefined()
        expect(client.ip).toBe('a:80')
    })
})
