/**
 * NodePool — caches node MID → IP mappings and deduplicates concurrent resolve requests.
 *
 * Ported from iOS NodePool.swift:
 * - Maintains a pool of nodes indexed by MID with their valid IPs
 * - Returns cached IPs when available (avoids redundant RPC calls)
 * - Deduplicates: if multiple callers resolve the same MID simultaneously,
 *   only one RPC is made and all callers share the result
 */

interface NodeInfo {
    mid: string
    ips: string[]
    lastUpdate: number
    successCount: number
}

class NodePool {
    private nodes = new Map<string, NodeInfo>()
    private inflightRequests = new Map<string, Promise<string[]>>()
    private failedIps = new Map<string, number>()  // ip -> failedAt timestamp
    private cacheTTL: number
    private readonly failedIpTTL = 60 * 1000  // 1 minute cooldown for dead IPs

    constructor(cacheTTL = 5 * 60 * 1000) {  // 5 minutes default
        this.cacheTTL = cacheTTL
    }

    /** Mark an IP as recently failed so callers can skip it for a cooldown period. */
    markIpFailed(ip: string) {
        this.failedIps.set(ip, Date.now())
    }

    /** Clear an IP from the failed list (call on a successful response from it). */
    clearIpFailed(ip: string) {
        this.failedIps.delete(ip)
    }

    /** Whether the IP is in the failure cooldown window. */
    isIpFailed(ip: string): boolean {
        const failedAt = this.failedIps.get(ip)
        if (!failedAt) return false
        if (Date.now() - failedAt > this.failedIpTTL) {
            this.failedIps.delete(ip)
            return false
        }
        return true
    }

    /** Get cached IPs for a node MID, or null if expired/missing */
    getIPs(mid: string): string[] | null {
        const node = this.nodes.get(mid)
        if (!node) return null
        if (Date.now() - node.lastUpdate > this.cacheTTL) {
            this.nodes.delete(mid)
            return null
        }
        return node.ips
    }

    /** Update node with resolved IPs */
    updateNode(mid: string, ips: string[]) {
        const existing = this.nodes.get(mid)
        this.nodes.set(mid, {
            mid,
            ips,
            lastUpdate: Date.now(),
            successCount: (existing?.successCount ?? 0) + 1
        })
    }

    /** Invalidate a node's cached IPs (e.g. after connection failure) */
    invalidate(mid: string) {
        this.nodes.delete(mid)
    }

    /** Remove a specific IP from a node. Removes the node entirely if no IPs remain. */
    removeIP(mid: string, ip: string) {
        const node = this.nodes.get(mid)
        if (!node) return
        node.ips = node.ips.filter(cached => cached !== ip)
        if (node.ips.length === 0) {
            this.nodes.delete(mid)
        }
    }

    /**
     * Resolve IPs with caching and inflight deduplication.
     * - If cached and not refreshing, returns cache immediately
     * - If an identical request is already in-flight, piggybacks on it
     * - Otherwise makes the RPC call via the provided resolver
     */
    async resolveIPs(
        mid: string,
        resolver: () => Promise<string[]>,
        refresh: boolean = false
    ): Promise<string[]> {
        // Return cached if available and not refreshing
        if (!refresh) {
            const cached = this.getIPs(mid)
            if (cached && cached.length > 0) {
                console.log(`[NodePool] Cache hit for ${mid}: ${cached.length} IP(s)`)
                return cached
            }
        }

        // Deduplicate: piggyback on in-flight request for the same mid+refresh combo
        const cacheKey = `${mid}:${refresh}`
        const inflight = this.inflightRequests.get(cacheKey)
        if (inflight) {
            console.log(`[NodePool] Dedup: joining in-flight request for ${mid}`)
            return inflight
        }

        // Make the actual RPC call
        const promise = resolver()
            .then(ips => {
                if (ips.length > 0) {
                    this.updateNode(mid, ips)
                }
                return ips
            })
            .finally(() => {
                this.inflightRequests.delete(cacheKey)
            })

        this.inflightRequests.set(cacheKey, promise)
        return promise
    }

    getStats() {
        return {
            totalNodes: this.nodes.size,
            totalIPs: Array.from(this.nodes.values()).reduce((sum, n) => sum + n.ips.length, 0),
            inflightRequests: this.inflightRequests.size
        }
    }
}

export const nodePool = new NodePool()
