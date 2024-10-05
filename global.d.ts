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
    alias?: string;
    profile?: string;

    likeCount?: number;
    bookmarkCount?: number;
    retweetCount?: number;
    commentCount?: number;
}

interface Tweet {
    mid: string;
    author: User;
    content?: string;
    attachments?: string[];
    timestamp?: string | number;
    originalTweetId?: string;
    originalTweet?: Tweet;
    originalAuthor?: User;
    comments?: Tweet[];
    client?: any;
}

interface ScorePair {
    score: number
    member: string
}

interface FVPair {
    field: string
    value: any
}