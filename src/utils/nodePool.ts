/**
 * NodePool — caches node MID → IP mappings and deduplicates concurrent resolve requests.
 *
 * Ported from iOS NodePool.swift:
 * - Maintains a pool of nodes indexed by MID with their valid IPs
 * - Returns cached healthy-preferred IPs when available (avoids redundant RPC calls)
 * - Deduplicates: if multiple callers resolve the same MID simultaneously,
 *   only one RPC is made and all callers share the result
 */
import { isPublicWebGatewayHost } from './browserNetwork'

interface NodeInfo {
    mid: string
    ips: string[]
    lastUpdate: number
    successCount: number
}

const NODE_POOL_STORAGE_KEY = 'tweetweb:nodePool:v1'

class NodePool {
    private nodes = new Map<string, NodeInfo>()
    private inflightRequests = new Map<string, Promise<string[]>>()
    private cacheTTL: number

    constructor(cacheTTL = 24 * 60 * 60 * 1000) {  // 24 hours default
        this.cacheTTL = cacheTTL
        this.loadFromStorage()
    }

    private getStorage(): Storage | null {
        try {
            if (typeof window === 'undefined') return null
            return window.sessionStorage
        } catch {
            return null
        }
    }

    private normalizeIP(address: string): string {
        let normalized = String(address ?? "").trim()
        if (normalized.startsWith("http://")) {
            normalized = normalized.slice(7)
        } else if (normalized.startsWith("https://")) {
            normalized = normalized.slice(8)
        }
        return normalized.replace(/\/+$/, "")
    }

    private normalizeNodeIPs(ips: string[]): string[] {
        return Array.from(new Set(
            ips
                .map(ip => this.normalizeIP(ip))
                // Web entry domains can resolve provider metadata, but they are
                // not storage nodes and must never enter the shared route cache.
                .filter(ip => ip.length > 0 && !isPublicWebGatewayHost(ip))
        ))
    }

    private getPreferredIP(ips: string[]): string | undefined {
        return ips.find(ip => {
            const normalized = this.normalizeIP(ip)
            return !normalized.startsWith("[") && (normalized.match(/:/g) || []).length <= 1
        }) ?? ips[0]
    }

    private loadFromStorage() {
        const storage = this.getStorage()
        if (!storage) return

        try {
            const raw = storage.getItem(NODE_POOL_STORAGE_KEY)
            if (!raw) return

            const parsed = JSON.parse(raw) as { nodes?: NodeInfo[] }
            if (!Array.isArray(parsed.nodes)) return

            const now = Date.now()
            let changed = false
            for (const node of parsed.nodes) {
                if (
                    typeof node?.mid !== 'string' ||
                    !Array.isArray(node.ips) ||
                    typeof node.lastUpdate !== 'number'
                ) {
                    continue
                }

                const storedIps = node.ips.filter(ip => typeof ip === 'string')
                const ips = this.normalizeNodeIPs(storedIps)
                if (ips.length !== storedIps.length) changed = true
                if (ips.length === 0) {
                    changed = true
                    continue
                }

                if (now - node.lastUpdate > this.cacheTTL) {
                    changed = true
                    continue
                }

                this.nodes.set(node.mid, {
                    mid: node.mid,
                    ips,
                    lastUpdate: node.lastUpdate,
                    successCount: typeof node.successCount === 'number' ? node.successCount : 0,
                })
            }

            if (changed) {
                this.persistToStorage()
            }
        } catch (error) {
            console.warn('[NodePool] Failed to load session cache, clearing it', error)
            storage.removeItem(NODE_POOL_STORAGE_KEY)
        }
    }

    private persistToStorage() {
        const storage = this.getStorage()
        if (!storage) return

        try {
            if (this.nodes.size === 0) {
                storage.removeItem(NODE_POOL_STORAGE_KEY)
                return
            }

            storage.setItem(
                NODE_POOL_STORAGE_KEY,
                JSON.stringify({ nodes: Array.from(this.nodes.values()) })
            )
        } catch (error) {
            console.warn('[NodePool] Failed to persist session cache', error)
        }
    }

    /** Get cached IPs for a node MID, or null if expired/missing */
    getIPs(mid: string): string[] | null {
        const node = this.nodes.get(mid)
        if (!node) return null
        if (Date.now() - node.lastUpdate > this.cacheTTL) {
            this.nodes.delete(mid)
            this.persistToStorage()
            return null
        }
        const ips = this.normalizeNodeIPs(node.ips)
        if (ips.length !== node.ips.length) {
            if (ips.length === 0) {
                this.nodes.delete(mid)
                this.persistToStorage()
                return null
            }
            node.ips = ips
            this.nodes.set(mid, node)
            this.persistToStorage()
        }
        return ips
    }

    /** Get the preferred cached IP for a node MID, preferring IPv4. */
    getIPForNode(mid: string): string | null {
        const ips = this.getIPs(mid)
        if (!ips?.length) return null
        return this.getPreferredIP(ips) ?? null
    }

    /** Update node with resolved IPs */
    updateNode(mid: string, ips: string[]) {
        const existing = this.nodes.get(mid)
        const normalizedIps = this.normalizeNodeIPs(ips)
        if (normalizedIps.length === 0) {
            if (existing) {
                this.nodes.delete(mid)
                this.persistToStorage()
            }
            return
        }
        this.nodes.set(mid, {
            mid,
            ips: normalizedIps,
            lastUpdate: Date.now(),
            successCount: (existing?.successCount ?? 0) + 1
        })
        this.persistToStorage()
    }

    /** Add an IP to a node without replacing the existing list. */
    addIPToNode(mid: string, ip: string) {
        const normalizedIP = this.normalizeIP(ip)
        if (!normalizedIP || isPublicWebGatewayHost(normalizedIP)) return

        const existing = this.nodes.get(mid)
        if (!existing) {
            this.updateNode(mid, [normalizedIP])
            return
        }

        if (!existing.ips.some(cached => this.normalizeIP(cached) === normalizedIP)) {
            existing.ips.push(normalizedIP)
        }
        existing.lastUpdate = Date.now()
        this.nodes.set(mid, existing)
        this.persistToStorage()
    }

    /** Invalidate a node's cached IPs (e.g. after connection failure) */
    invalidate(mid: string) {
        this.nodes.delete(mid)
        this.persistToStorage()
    }

    /** Remove a specific IP from a node. Removes the node entirely if no IPs remain. */
    removeIP(mid: string, ip: string) {
        const node = this.nodes.get(mid)
        if (!node) return
        const normalizedIP = this.normalizeIP(ip)
        node.ips = node.ips.filter(cached => this.normalizeIP(cached) !== normalizedIP)
        if (node.ips.length === 0) {
            this.nodes.delete(mid)
        }
        this.persistToStorage()
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
                const normalizedIps = this.normalizeNodeIPs(ips)
                if (normalizedIps.length > 0) {
                    this.updateNode(mid, normalizedIps)
                } else {
                    this.invalidate(mid)
                }
                return normalizedIps
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
