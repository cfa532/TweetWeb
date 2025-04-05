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
    hostId?: MimeiId;
    providerIp?: string;  // Provider's IP that has write permission
    client?: any;       // Hprose client handler
    timestamp: string | number = Date.now();
    followingCount?: number;
    followersCount?: number;
    tweetCount?: number;
    cloudDrivePort?: number;
    hostUrl?: string;
};

interface Tweet {
    mid: MimeiId;
    authorId: MimeiId;
    author: User;
    content?: string;
    title?: string;
    attachments?: MimeiFileType[];
    timestamp: string | number = Date.now();
    originalTweetId?: MimeiId;
    originalTweet?: Tweet;
    originalAuthorId?: MimeiId;
    comments?: Tweet[];

    likeCount?: number;
    bookmarkCount?: number;
    retweetCount?: number;
    commentCount?: number;

    provider?: string;       // Hprose client handler
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
    timestamp: string | number = Date.now()
    aspectRatio?: number    // for video files

    // not saved in Mimei DB, for display only. The value is assigned from Tweet's downloadable
    // upload render the attachment.
    downloadable?: boolean = true
};

// File type returned by network drive
type FileSystemItem = {
    userId: MimeiId;    // user who shared the file
    name: string;
    path: string;
    isDirectory: boolean;
    size: number = 0;
    modified: string = Date.now(); // ISO 8601 date string
    url: string;
};
