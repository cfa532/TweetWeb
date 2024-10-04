
interface User {
    avatar: string | undefined;
    username: string;
    alias: string | undefined;
    profile: string | undefined;
}

interface Tweet {
    tweetId: string;
    user: User;
    content: string | undefined;
    media: string[] | undefined;
    timestamp: string | undefined;
}