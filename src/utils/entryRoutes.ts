/**
 * Ordering of the entry-node candidate list.
 *
 * The Leither boot page publishes every address it knows through
 * `window.setParam({ addrs: ... })`, grouped BY NODE:
 *
 *   addrs[node] = [[ip, metric], [ip, metric], ...]
 *
 * One node contributes several addresses because it is reachable on several
 * interfaces — public IPv4, IPv6, tailnet, LAN — and the metric orders those
 * addresses by how fast that interface answers for that node. The grouping is
 * the part that matters and the part the old flattening threw away: reading the
 * groups end to end puts a node's LAN address directly behind its own public
 * one, so the fallback after a failure is the same machine on another
 * interface. It is down for the same reason, and every one of its addresses has
 * to fail before a different node is tried at all.
 *
 * Interleave by rank instead — every node's fastest address, then every node's
 * second fastest, and so on — so the next candidate after a failure is always a
 * different node.
 *
 * This list exists for one path: opening a tweet detail view cold, a deep link
 * above all. Nothing is cached then, so `get_provider_ips` has to answer before
 * the tweet can be fetched at all, and the boot page's own flat `ips` list left
 * that call with a single address to try.
 */
import { browserUsableProviderRoutes, isPrivateBrowserHost } from './browserNetwork'

/** The parameter block the Leither boot page exposes via `window.getParam()`. */
export interface LeitherEntryParam {
    /** Node-grouped addresses: addrs[node] = [[ip, metric], ...]. */
    addrs?: unknown
    /** Flat candidate list the boot page raced, in the order it raced them. */
    ips?: unknown
    /** Index into `ips` of the address that served this page. */
    CurNode?: unknown
}

function normalizeAddress(value: unknown): string {
    const raw = String(value ?? '').trim()
    if (!raw) return ''
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/**
 * A malformed or missing metric sorts last rather than dropping the address:
 * an address the node published is still a way in, just an unranked one.
 */
function metricOf(pair: unknown): number {
    const value = Array.isArray(pair) ? pair[1] : undefined
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

/** One node's addresses, fastest first. */
function nodeAddresses(node: unknown): string[] {
    if (!Array.isArray(node)) return []
    return [...node]
        .filter(pair => Array.isArray(pair))
        .sort((a, b) => metricOf(a) - metricOf(b))
        .map(pair => normalizeAddress((pair as unknown[])[0]))
        .filter(address => address.length > 0)
}

/**
 * Take one address from each node in turn: all the rank-0 addresses, then all
 * the rank-1 addresses, and so on until every node is exhausted. Nodes with
 * fewer addresses simply drop out of the later rounds.
 */
function interleaveByRank(nodes: string[][]): string[] {
    const ordered: string[] = []
    const seen = new Set<string>()
    const depth = nodes.reduce((max, node) => Math.max(max, node.length), 0)

    for (let rank = 0; rank < depth; rank++) {
        for (const node of nodes) {
            const address = node[rank]
            // The same address can be published by two nodes behind one NAT;
            // it is one way in either way, and belongs at its first position.
            if (!address || seen.has(address)) continue
            seen.add(address)
            ordered.push(address)
        }
    }
    return ordered
}

/** The address that actually served this page, per the boot page's own record. */
function servingAddress(param: LeitherEntryParam): string {
    const ips = Array.isArray(param.ips) ? param.ips : []
    const index = typeof param.CurNode === 'number' ? param.CurNode : -1
    return index >= 0 && index < ips.length ? normalizeAddress(ips[index]) : ''
}

/**
 * Build the ordered entry-node candidate list for this browser.
 *
 * @param param what `window.getParam()` returned, or null when the page was not
 *   served by a Leither boot page at all.
 * @param originHostname `window.location.hostname` — decides which routes this
 *   browser is allowed to open at all.
 */
export function orderEntryRoutes(
    param: LeitherEntryParam | null | undefined,
    originHostname: string,
): string[] {
    if (!param) return []

    const nodes = (Array.isArray(param.addrs) ? param.addrs : [])
        .map(nodeAddresses)
        .filter(node => node.length > 0)

    // A boot page older than this ordering publishes only the flat list it
    // raced. It is already roughly node-aligned in its first pass, so it is a
    // usable fallback — just not one that can be re-grouped.
    const candidates = nodes.length > 0
        ? interleaveByRank(nodes)
        : (Array.isArray(param.ips) ? param.ips.map(normalizeAddress).filter(Boolean) : [])

    // A browser on the open internet cannot open a LAN or tailnet route at all,
    // so those sink below the publicly routable ones — but they stay in the
    // list, because on a private deployment they are the only way in. Order is
    // preserved within each group, so consecutive candidates remain different
    // nodes.
    const publicFirst = [
        ...candidates.filter(address => !isPrivateBrowserHost(address)),
        ...candidates.filter(address => isPrivateBrowserHost(address)),
    ]

    const usable = browserUsableProviderRoutes(publicFirst, originHostname)

    // The node that served this page answered a real request moments ago, which
    // outranks any published metric. Everything else keeps its order behind it.
    const servedBy = servingAddress(param)
    if (servedBy && usable.includes(servedBy)) {
        return [servedBy, ...usable.filter(address => address !== servedBy)]
    }
    return usable
}
