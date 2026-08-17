import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import ConnectionPoolManager from '@/utils/connectionPool';
import { isPublicWebGatewayHost } from '@/utils/browserNetwork';
import { orderEntryRoutes } from '@/utils/entryRoutes';
import { createEntryClient, DEFAULT_ENTRY_TIMEOUT_MS } from '@/utils/entryClient';

const ayApi = ["GetVarByContext", "Act", "Login", "Getvar", "SwarmLocal", "DhtGetAllKeys",
    "MFOpenByPath","DhtGet", "DhtGets", "SignPPT", "RequestService", "SwarmAddrs",
    "MFOpenTempFile", "MFTemp2MacFile", "MFSetData", "MFGetData", "MMCreate", "MMOpen",
    "Hset", "Hget", "Hmset", "Hmget", "Zadd", "Zrangebyscore", "Zrange", "MFOpenMacFile",
    "MFReaddir", "MFGetMimeType", "MFSetObject", "MFGetObject", "Zcount", "Zrevrange",
    "Hlen", "Hscan", "Hrevscan", "MMRelease", "MMBackup", "MFStat", "Zrem",  "RunMApp",
    "Zremrangebyscore", "MiMeiPublish", "PullMsg", "MFTemp2Ipfs", "MFSetCid", "MMSum",
    "MiMeiSync", "IpfsAdd", "MMAddRef", "MMDelRef", "MMDelVers", "MMRelease", "MMGetRef",
    "MMGetRefs", "Hdel", "DhtFindPeer", "Logout", "MiMeiPublish", "MMSetRight",
];

/**
 * Ordered entry-node candidates, best first.
 *
 * The boot page publishes every address it knows, grouped by node;
 * orderEntryRoutes turns that into a list whose consecutive entries are
 * different nodes, so the client below can fail over to a machine that is not
 * down for the same reason as the one that just failed. Only the single winner
 * used to survive this step, which left nothing to fail over to.
 */
function getEntryRoutes(): string[] {
    // A configured node is the entire list: it exists to pin every request to
    // one machine, and failing over would defeat the point of setting it.
    if (import.meta.env.VITE_LEITHER_NODE) return [import.meta.env.VITE_LEITHER_NODE]

    // getParam is a Leither function
    if (window.getParam != null) {
        const p = window.getParam()
        console.log(p)
        const routes = orderEntryRoutes(p, window.location.hostname)
        if (routes.length > 0) return routes
    }

    // Served by something that is not a Leither boot page — the public gateway,
    // or a dev server. That origin is the only entry there is.
    if (window.location.host != "") {
        console.log("window.location", window.location.host)
        return [window.location.host]
    }
    return ["127.0.0.1:4800"]
};
const entryRoutes = getEntryRoutes();

// Create a singleton connection pool manager
const connectionPool = new ConnectionPoolManager(ayApi);

/**
 * The gateway terminates TLS for the app and proxies to a node, so its own
 * protocol is the one to keep. Every other origin talks to node addresses
 * directly over plain HTTP.
 */
function createHproseClient(address: string) {
    const protocol = isPublicWebGatewayHost(window.location.hostname) ? window.location.protocol : 'http:';
    const client = window.hprose.Client.create(protocol + "//" + address + "/webapi/", ayApi);
    client.timeout = DEFAULT_ENTRY_TIMEOUT_MS;
    return client;
}

export const useLeitherStore = defineStore({
    id: 'LeitherApiHandler', 
    state: ()=>({
        sid: "",
        appId: import.meta.env.VITE_MIMEI_APPID,
        returnUrl: "",
        entryRoutes,      // ordered entry-node candidates, one node after another
        // markRaw: the client is a Proxy that answers every property with an RPC
        // wrapper, so Vue must not walk it looking for reactive internals.
        client: markRaw(createEntryClient({ routes: entryRoutes, createClient: createHproseClient })),
        logoUrl: import.meta.env.VITE_APP_LOGO,
        connectionPool: connectionPool as ConnectionPoolManager,
    }),
    getters: {
        /** Address of the entry node currently answering; rotates on failover. */
        hostIP: (state): string => state.client.ip,
        baseUrl: (state): string => window.location.protocol + '//' + state.client.ip + '/',
    },
    actions: {
        /**
         * Get a client from the connection pool
         * @param ip The IP address to connect to
         * @returns A promise that resolves to an hprose client
         */
        async getClient(ip: string) {
            return await this.connectionPool.getConnection(ip);
        },
        
        /**
         * Release a client back to the connection pool
         * @param ip The IP address of the client
         * @param client The client to release
         */
        releaseClient(ip: string, client: any) {
            this.connectionPool.releaseConnection(ip, client);
        },
        
        /**
         * Execute a function with a pooled client, automatically releasing it when done
         * @param ip The IP address to connect to
         * @param fn The function to execute with the client
         * @returns The result of the function
         */
        async withClient<T>(ip: string, fn: (client: any) => Promise<T>): Promise<T> {
            const client = await this.getClient(ip);
            try {
                return await fn(client);
            } finally {
                this.releaseClient(ip, client);
            }
        },
        
        /**
         * Get connection pool statistics
         */
        getPoolStats() {
            return this.connectionPool.getStats();
        }
    }
})
