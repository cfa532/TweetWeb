interface Window {
    mmInfo: any       // add to window obj for testing convenience
    getParam: any
    hprose: any
    lapi: any         // Leither api handler
}

interface User {
    mid: string;
    avatar?: string;
    username: string;
    name?: string;
    profile?: string;

    provider?: string;  // IP of the best provider
    client?: any;       // Hprose client handler
}

interface Tweet {
    mid: string;
    author: User;
    content?: string;
    attachments?: MimeiFileType[];
    timestamp?: string | number;
    originalTweetId?: string;
    originalTweet?: Tweet;
    originalAuthorId?: string;
    comments?: Tweet[];

    likeCount?: number;
    bookmarkCount?: number;
    retweetCount?: number;
    commentCount?: number;

    provider?: string;       // Hprose client handler
}

interface ScorePair {
    score: number
    member: string
}

interface FVPair {
    field: string
    value: any
}

interface MimeiFileType {
    mid: string
    type: string
    size?: number
}
