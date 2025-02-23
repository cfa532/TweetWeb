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
    hostIds?: MimeiId[];
    providerIp?: string;  // IP of the best provider for the author's data
    client?: any;       // Hprose client handler
    timestamp: string | number = Date.now();
    followingCount?: number;
    followerCount?: number;
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

interface MimeiFileType {
    mid: string
    type: string
    size?: number
    fileName?: string
    timestamp: string | number = Date.now()
    aspectRatio?: number

    // not saved in Mimei DB, for display only. The value is assigned from Tweet's downloadable
    // upload render the attachment.
    downloadable?: boolean
};