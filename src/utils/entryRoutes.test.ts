import { describe, expect, it } from 'vitest'
import { orderEntryRoutes } from './entryRoutes'

// The shape a real node publishes: three nodes, each reachable on several
// interfaces, each interface ranked by how fast it answers for that node.
const ADDRS = [
    [
        ['125.229.161.122:8080', 18505351],
        ['100.89.71.56:8080', 447133897],
        ['[2001:b011:e606:b7f9:2e0:1dff:feed:3d1]:8080', 35193349453816],
        ['192.168.5.4:8080', 281476078241027],
        ['10.8.0.2:8080', 281476939120639],
        ['10.8.0.1:8080', 281476939120640],
    ],
    [
        ['115.196.228.69:8002', 188423100],
        ['100.79.13.15:8002', 447804146],
    ],
    [
        ['115.196.228.69:8081', 188423100],
        ['100.73.230.60:8081', 448141765],
    ],
]

describe('entry route ordering', () => {
    it('takes one address per node per round, fastest rank first', () => {
        expect(orderEntryRoutes({ addrs: ADDRS }, '192.168.5.10')).toEqual([
            // rank 0 of every node
            '125.229.161.122:8080',
            '115.196.228.69:8002',
            '115.196.228.69:8081',
            // node 0's next public route; private addresses were filtered first
            '[2001:b011:e606:b7f9:2e0:1dff:feed:3d1]:8080',
        ])
    })

    it('never places two addresses of the same node next to each other while another node has one left', () => {
        const routes = orderEntryRoutes({ addrs: ADDRS }, '192.168.5.10')
        const nodeOf = (address: string) =>
            ADDRS.findIndex(node => node.some(pair => pair[0] === address))

        // Each public rank alternates nodes while another node has a route.
        expect(routes.slice(0, 3).map(nodeOf)).toEqual([0, 1, 2])
        expect(routes.slice(3).map(nodeOf)).toEqual([0])
    })

    it('leads with the node that actually served the page', () => {
        const routes = orderEntryRoutes(
            { addrs: ADDRS, ips: ['125.229.161.122:8080', '115.196.228.69:8002'], CurNode: 1 },
            '192.168.5.10',
        )
        expect(routes[0]).toBe('115.196.228.69:8002')
        // and it is not duplicated further down
        expect(routes.filter(route => route === '115.196.228.69:8002')).toHaveLength(1)
    })

    it('selects up to two public addresses per node after removing private routes', () => {
        expect(orderEntryRoutes({ addrs: ADDRS }, 'dl.dtweet.com', 2)).toEqual([
            '125.229.161.122:8080',
            '115.196.228.69:8002',
            '115.196.228.69:8081',
            '[2001:b011:e606:b7f9:2e0:1dff:feed:3d1]:8080',
        ])
    })

    it('never promotes a private page-serving address into race or failover routes', () => {
        const param = { addrs: ADDRS, ips: ['192.168.5.4:8080'], CurNode: 0 }
        expect(orderEntryRoutes(param, 't1.www33.shop', 2)).not.toContain('192.168.5.4:8080')
        expect(orderEntryRoutes(param, 't1.www33.shop')).not.toContain('192.168.5.4:8080')
    })

    it('filters LAN and VPN addresses before taking two slots, including on a private origin', () => {
        const addrs = [[
            ['192.168.1.1:8080', 1],
            ['100.64.1.1:8080', 2],
            ['198.18.0.1:8080', 3],
            ['26.26.26.1:8080', 4],
            ['[fd00::1]:8080', 5],
            ['[2001::ffff:ffff:ffff:fff1]:8080', 6],
            ['1.1.1.1:8080', 7],
            ['[2606:4700:4700::1111]:8080', 8],
            ['8.8.8.8:8080', 9],
        ]]
        expect(orderEntryRoutes({ addrs }, '192.168.1.2', 2)).toEqual([
            '1.1.1.1:8080', '[2606:4700:4700::1111]:8080',
        ])
        expect(orderEntryRoutes({ addrs }, '192.168.1.2')).toEqual([
            '1.1.1.1:8080', '[2606:4700:4700::1111]:8080', '8.8.8.8:8080',
        ])
    })

    it('keeps two ranked fallback IPs for a private-only node alongside another public node', () => {
        const addrs = [
            [['192.168.1.1:8080', 30], ['100.64.1.1:8080', 10], ['[fd00::1]:8080', 20]],
            [['10.1.1.1:8080', 1], ['1.1.1.1:8080', 40]],
        ]
        const expected = ['100.64.1.1:8080', '1.1.1.1:8080', '[fd00::1]:8080']
        expect(orderEntryRoutes({ addrs }, 'dl.dtweet.com', 2)).toEqual(expected)
        expect(orderEntryRoutes({ addrs }, 'dl.dtweet.com')).toEqual(expected)
    })

    it('does not fill a second slot with a private IP when the node has one public IP', () => {
        const addrs = [[['100.64.1.1:8080', 1], ['1.1.1.1:8080', 2]]]
        expect(orderEntryRoutes({ addrs }, 'dl.dtweet.com', 2)).toEqual(['1.1.1.1:8080'])
    })

    it('rejects malformed IPs instead of counting them as private-only fallbacks', () => {
        const addrs = [[['node.example.com:8080', 1], ['999.1.1.1:8080', 2], ['192.168.1.1:8080', 3]]]
        expect(orderEntryRoutes({ addrs }, 'dl.dtweet.com', 2)).toEqual(['192.168.1.1:8080'])
    })

    it('sorts each node by metric before interleaving', () => {
        const unsorted = [
            [['1.1.1.1:80', 300], ['1.1.1.2:80', 100]],
            [['2.2.2.1:80', 200]],
        ]
        expect(orderEntryRoutes({ addrs: unsorted }, '192.168.5.10')).toEqual([
            '1.1.1.2:80',
            '2.2.2.1:80',
            '1.1.1.1:80',
        ])
    })

    it('keeps an address published without a metric, ranked last within its node', () => {
        const partial = [
            [['1.1.1.1:80', 300], ['1.1.1.2:80']],
            [['2.2.2.1:80', 200]],
        ]
        expect(orderEntryRoutes({ addrs: partial }, '192.168.5.10')).toEqual([
            '2.2.2.1:80',
            '1.1.1.1:80',
            '1.1.1.2:80',
        ])
    })

    it('orders each round by metric, so the quickest of the nodes leads', () => {
        const slowFirstNode = [
            [['1.1.1.1:80', 900], ['1.1.1.2:80', 950]],
            [['2.2.2.1:80', 100], ['2.2.2.2:80', 200]],
        ]
        expect(orderEntryRoutes({ addrs: slowFirstNode }, '192.168.5.10')).toEqual([
            // round 0: both nodes' fastest, quickest first
            '2.2.2.1:80',
            '1.1.1.1:80',
            // round 1: both nodes' second fastest, same rule
            '2.2.2.2:80',
            '1.1.1.2:80',
        ])
    })

    it('collapses one address published by two nodes to its first position', () => {
        const shared = [
            [['1.1.1.1:80', 100], ['9.9.9.9:80', 200]],
            [['9.9.9.9:80', 100]],
        ]
        expect(orderEntryRoutes({ addrs: shared }, '192.168.5.10')).toEqual([
            '1.1.1.1:80',
            '9.9.9.9:80',
        ])
    })

    it('falls back to the flat list a boot page without addrs publishes', () => {
        expect(orderEntryRoutes(
            { ips: ['125.229.161.122:8080', '192.168.5.4:8080', '115.196.228.69:8002'] },
            '192.168.5.10',
        )).toEqual([
            '125.229.161.122:8080',
            '115.196.228.69:8002',
        ])
    })

    it('does not guess a per-node race sample from an older flat list', () => {
        expect(orderEntryRoutes({ ips: ['1.1.1.1:80'] }, 't1.www33.shop', 2)).toEqual([])
    })

    it('retains up to two IPs when an older flat list has no public addresses', () => {
        expect(orderEntryRoutes({ ips: ['192.168.1.1:8080', '100.64.1.1:8080', '[fd00::1]:8080'] },
            'dl.dtweet.com')).toEqual(['192.168.1.1:8080', '100.64.1.1:8080'])
    })

    it('returns nothing when the page was not served by a boot page', () => {
        expect(orderEntryRoutes(null, 'dl.dtweet.com')).toEqual([])
        expect(orderEntryRoutes({}, 'dl.dtweet.com')).toEqual([])
        expect(orderEntryRoutes({ addrs: 'garbage' }, 'dl.dtweet.com')).toEqual([])
    })
})
