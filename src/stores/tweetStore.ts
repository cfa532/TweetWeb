import { defineStore } from 'pinia';

interface User {
    avatar: string;
    username: string;
    alias: string;
    profile: string;
}

interface Tweet {
    tweetId: string;
    user: User;
    content: string;
    media: string[];
    timestamp: string;
}

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[]
    }),
    actions: {
        fetchTweet(userId: string, tweetId: string): Tweet | undefined {
            // Simulate fetching a tweet by userId and tweetId
            return this.tweets.find(tweet => tweet.user.username === userId && tweet.timestamp === tweetId);
        }
    }
});

export type { Tweet, User };