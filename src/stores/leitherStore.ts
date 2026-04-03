import { defineStore } from 'pinia';
import ConnectionPoolManager from '@/utils/connectionPool';

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

function getCurNodeIP() {
    let ip = "127.0.0.1:4800"
    // getParam is a Leither function
    if (window.getParam != null){
        let p=window.getParam()
        ip = p["ips"][p.CurNode]
        console.log(p)
    } else if (window.location.host != ""){
        ip = window.location.host
        console.log("window.location", ip)
    }
    // replace IP with testing node if defined
    return import.meta.env.VITE_LEITHER_NODE ? import.meta.env.VITE_LEITHER_NODE : ip
};
const curIP = getCurNodeIP();

// Create a singleton connection pool manager
const connectionPool = new ConnectionPoolManager(ayApi);

export const useLeitherStore = defineStore({
    id: 'LeitherApiHandler', 
    state: ()=>({
        sid: "",
        appId: import.meta.env.VITE_MIMEI_APPID,
        returnUrl: "",
        hostIP: curIP,    // IP address of node to write
        baseUrl: window.location.protocol+'//'+curIP+'/',
        client: (() => {
            const c = window.hprose.Client.create("http://" + curIP + "/webapi/", ayApi);
            c.timeout = 15000;
            return c;
        })(),
        // client: window.hprose.Client.create("ws://" + curIP +"/ws/", ayApi),
        logoUrl: import.meta.env.VITE_APP_LOGO,
        connectionPool: connectionPool as ConnectionPoolManager,
    }),
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