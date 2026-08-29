/**
 * The entry client — the single client every node lookup goes through.
 *
 * `get_provider_ips` and `get_node_ips` are how the app finds any other node,
 * so until one of them answers there is no route to anything: a tweet, a
 * profile, an avatar. That is the whole of a cold-start deep link — nothing is
 * cached, so the detail view cannot resolve its author's providers until this
 * client answers. Binding it to one address made the node that served the page
 * a single point of failure, and the detail view's retry went back to it.
 *
 * This client walks the node-interleaved candidate list from `orderEntryRoutes`
 * instead. On a transport failure it advances to the next candidate — a
 * different node, by construction of that list — and stays there, so one dead
 * node costs one failed call rather than every call after it.
 *
 * Only a thrown error rotates the route. A null RPC result is an answer from a
 * healthy node ("no providers for this mid"), not a routing failure, and the
 * caller is the one that knows what to do with it.
 *
 * Walking on costs nothing when repeating the call is harmless, which every
 * lookup here is. It is not harmless for a call that writes: see
 * `callWithoutFailover`.
 */

/** Nodes tried per call before the error is handed back to the caller. */
export const MAX_ENTRY_ROUTE_ATTEMPTS = 3

export const DEFAULT_ENTRY_TIMEOUT_MS = 15000

export interface EntryClientOptions {
    /** Ordered candidates; consecutive entries are expected to be different nodes. */
    routes: string[]
    /** Builds the underlying RPC client for one address. Injected for testing. */
    createClient: (address: string) => any
    timeout?: number
    maxAttempts?: number
}

// Vue walks anything it stores reactively and probes it with these. Returning a
// callable for them makes the proxy look like a ref/thenable and corrupts the
// store; `__v_`-prefixed reads fall through to the target so markRaw() works.
const IGNORED_PROPS = [
    'toJSON', 'toString', 'valueOf', 'constructor', 'prototype',
    '__proto__', 'then', 'catch', 'finally',
]

export function createEntryClient({
    routes,
    createClient,
    timeout = DEFAULT_ENTRY_TIMEOUT_MS,
    maxAttempts = MAX_ENTRY_ROUTE_ATTEMPTS,
}: EntryClientOptions): any {
    const candidates = routes.map(route => String(route ?? '').trim()).filter(Boolean)
    if (candidates.length === 0) {
        throw new Error('[entryClient] No entry route to start from')
    }

    const clients = new Map<string, any>()
    let activeIndex = 0
    let currentTimeout = timeout

    const clientFor = (index: number) => {
        const address = candidates[index]
        let client = clients.get(address)
        if (!client) {
            client = createClient(address)
            clients.set(address, client)
        }
        // Applied per call: callers change the timeout on the client they hold
        // (registration uses a longer one), and that has to reach whichever
        // underlying client actually makes the request.
        client.timeout = currentTimeout
        return client
    }

    const call = async (method: string, args: any[], attemptLimit = maxAttempts) => {
        const attempts = Math.min(candidates.length, Math.max(1, attemptLimit))
        // Walk from where the pointer stood when this call began. Reading the
        // live pointer each time skips nodes, because a failure below moves it
        // and the next offset is then measured from the node already tried.
        const start = activeIndex
        let lastError: unknown

        for (let attempt = 0; attempt < attempts; attempt++) {
            const index = (start + attempt) % candidates.length
            try {
                const result = await clientFor(index)[method](...args)
                // Stay on whatever answered rather than returning to a node that
                // is still down.
                activeIndex = index
                return result
            } catch (error) {
                lastError = error
                // Move the shared pointer only while it still names the route
                // that just failed. Concurrent callers otherwise each advance it
                // once and skip healthy nodes in between.
                if (activeIndex === index) activeIndex = (index + 1) % candidates.length
                console.warn(
                    `[entryClient] ${method} failed on ${candidates[index]}` +
                    (attempt + 1 < attempts ? `; trying ${candidates[(index + 1) % candidates.length]}` : ''),
                    error
                )
            }
        }
        throw lastError
    }

    return new Proxy({}, {
        get(target, prop) {
            if (prop === 'timeout') return currentTimeout
            // Anything written onto the client wins over the RPC wrapper, the
            // way it did when this was a plain hprose client: markRaw() writes
            // its __v_ flags here, and tests stub individual methods.
            if (Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target, prop)
            // An unset reactivity flag must read as undefined, not as a
            // callable: a truthy __v_isRef would have Vue unwrap the client.
            if (typeof prop === 'symbol' || IGNORED_PROPS.includes(prop) || prop.startsWith('__v_')) {
                return undefined
            }

            /** Address currently answering; rotates on failover. */
            if (prop === 'ip') return candidates[activeIndex]

            /**
             * One attempt on the route answering now, with no failover, for a call that
             * must not run twice. Retrying a write is not a free retry: `register`
             * creates the account, so a node that runs past the timeout still finishes
             * it, and the next node then reports the username as taken — for the account
             * the caller just made. iOS and Android make this call once against a single
             * node; this keeps the web the same.
             *
             * Takes the RPC method first because every app entry goes out as `RunMApp`,
             * so the entry name is an argument and cannot select this by itself.
             */
            if (prop === 'callWithoutFailover') {
                return (method: string, ...args: any[]) => call(method, args, 1)
            }

            return (...args: any[]) => call(prop, args)
        },

        set(target, prop, value) {
            if (prop === 'timeout') {
                currentTimeout = value
                return true
            }
            return Reflect.set(target, prop, value)
        },
    })
}
