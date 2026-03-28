type MimeiId = string;

interface Gtag {
    (...args: any[]): void;
}

interface Window {
    mmInfo: any       // add to window obj for testing convenience
    getParam: any
    hprose: any
    lapi: any         // Leither api handler
    dataLayer: any[];
    gtag: Gtag;
};

interface User {
    mid: MimeiId;
    avatar?: string;
    username: string;
    name?: string;
    profile?: string;
    hostIds?: MimeiId[];  // Array of host IDs, where hostIds[0] may be read host and hostIds[1] may be write host
    providerIp?: string;  // Provider's IP that has write permission
    writableHostIp?: string | null;  // Cached writable host IP, fetched lazily when needed
    client?: any;       // Hprose client handler
    timestamp: string | number;
    followingCount?: number;
    followersCount?: number;
    tweetCount?: number;
    cloudDrivePort?: number;  // Port for backend service (undefined/null/0 means no service)
    hostUrl?: string;
};

interface Tweet {
    mid: MimeiId;
    authorId: MimeiId;
    author: User;
    content?: string;
    title?: string;
    attachments?: MimeiFileType[];
    timestamp: string | number;
    originalTweetId?: MimeiId;
    originalTweet?: Tweet | null;
    originalAuthorId?: MimeiId;
    comments?: Tweet[];

    likeCount?: number;
    bookmarkCount?: number;
    retweetCount?: number;
    commentCount?: number;

    provider?: string;       // Hprose client handler
    playlist?: string;       // Cached resolved HLS playlist filename (e.g. master.m3u8)
    downloadable?: boolean;
    isPrivate?: boolean;
};

interface ScorePair {
    score: number
    member: string
};

interface FVPair {
    field: string
    value: any
};

// Type of passing attachments as Mimei
interface MimeiFileType {
    mid: string
    type: string
    size?: number
    fileName?: string
    timestamp: string | number
    aspectRatio?: number    // for video files

    // not saved in Mimei DB, for display only. The value is assigned from Tweet's downloadable
    // upload render the attachment.
    downloadable?: boolean
};

// File type returned by network drive
type FileSystemItem = {
    userId: MimeiId;    // user who shared the file
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modified: string; // ISO 8601 date string
    url: string;
};
