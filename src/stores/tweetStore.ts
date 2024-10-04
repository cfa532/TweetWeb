import { defineStore } from 'pinia';

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