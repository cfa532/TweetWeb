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
            // rank 2 of node 0 — public, so it stays ahead of the tailnet block
            '[2001:b011:e606:b7f9:2e0:1dff:feed:3d1]:8080',
            // rank 1 of every node, all tailnet
            '100.89.71.56:8080',
            '100.79.13.15:8002',
            '100.73.230.60:8081',
            // node 0's remaining LAN interfaces
            '192.168.5.4:8080',
            '10.8.0.2:8080',
            '10.8.0.1:8080',
        ])
    })

    it('never places two addresses of the same node next to each other while another node has one left', () => {
        const routes = orderEntryRoutes({ addrs: ADDRS }, '192.168.5.10')
        const nodeOf = (address: string) =>
            ADDRS.findIndex(node => node.some(pair => pair[0] === address))

        // Within the public block and within the private block, the ordering
        // alternates nodes for as long as there is another node to alternate to.
        expect(routes.slice(0, 3).map(nodeOf)).toEqual([0, 1, 2])
        expect(routes.slice(4, 7).map(nodeOf)).toEqual([0, 1, 2])
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

    it('drops routes the browser cannot open from a public origin', () => {
        expect(orderEntryRoutes({ addrs: ADDRS }, 'dl.dtweet.com')).toEqual([
            '125.229.161.122:8080',
            '115.196.228.69:8002',
            '115.196.228.69:8081',
            '[2001:b011:e606:b7f9:2e0:1dff:feed:3d1]:8080',
        ])
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
            '1.1.1.1:80',
            '2.2.2.1:80',
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
            '192.168.5.4:8080',
        ])
    })

    it('returns nothing when the page was not served by a boot page', () => {
        expect(orderEntryRoutes(null, 'dl.dtweet.com')).toEqual([])
        expect(orderEntryRoutes({}, 'dl.dtweet.com')).toEqual([])
        expect(orderEntryRoutes({ addrs: 'garbage' }, 'dl.dtweet.com')).toEqual([])
    })
})
