import { defineStore } from 'pinia';

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

export const useLeitherStore = defineStore({
    id: 'LeitherApiHandler', 
    state: ()=>({
        sid: "",
        appId: import.meta.env.VITE_MIMEI_APPID,
        returnUrl: "",
        baseIP: curIP,
        hostIP: "",    // IP address of node to write
        baseUrl: window.location.protocol+'//'+curIP+'/' ,
        client: window.hprose.Client.create("ws://" + curIP +"/ws/", ayApi),
    }),
    actions: {
        getClient(ip: string) {
            return window.hprose.Client.create("ws://" + ip +"/ws/", ayApi)
        },
    }
})