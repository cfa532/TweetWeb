import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';

export const useTweetListStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],
        authors: [] as User[],
        followings: ["yifT_a-gWN9-JXsJ6P7gqizKMDM", "agvvgWJmmXtji5FLTt768Plu3He"],
        lapi: useLeitherStore(),
    }),
    actions: {
        // Load tweets of a list of followed User IDs
        async loadTweets() {
            this.followings.forEach(async uid => {
                let author = await this.getUser(uid)
                if (!author) return
                let ts = await this.getTweetListByUser(author)
                if (!ts) return

                // Each tweet does not have its author data yet.
                ts.forEach(async t => {
                    if (this.tweets.find(e => { e.mid == t.mid }))
                        return
                    t.author = author
                    t.provider = author.provider
                    t.attachments = t.attachments?.map(e => {
                        return this.getMediaUrl(e, "http://" + author.provider)
                    })
                    t.comments = []

                    if (t.originalTweetId) {
                        t.originalTweet = await this.getTweet(t.originalTweetId)
                    }
                    if (this.tweets.findIndex(e => e.mid === t.mid) === -1) {
                        this.tweets = this.tweets.concat(t);
                    }
                })
            })
        },

        async getTweetListByUser(author: User): Promise<Tweet[] | undefined> {
            return await author.client.RunMApp("get_tweets", {
                aid: this.lapi.appId,
                ver: "last",
                userid: author.mid,
                start: Date.now(),
                end: Date.now() - 2592000000
            })
        },

        // Given only tweet ID, find it full data.
        async getTweet(tweetId: string): Promise<Tweet | undefined> {
            let tweet = this.tweets.find(t => { t.mid == tweetId })
            if (tweet) return tweet

            tweet = await this.fetchTweet(tweetId)
            console.log(tweet, tweetId)
            if (!tweet) return

            if (tweet?.originalTweetId) {
                let orig = await this.fetchTweet(tweet.originalTweetId)
                tweet.originalTweet = orig
                tweet.originalAuthor = orig?.author
            }
            console.log(tweet)
            return tweet
        },

        // Given tweet ID, get its content. There are 2 steps. First, find provider of
        // this tweet with its ID. 2nd, retrieve the tweet from the provider. Assume
        // author data is also available on the provider. Get author data too.
        async fetchTweet(tweetId: string): Promise<Tweet | undefined> {

            // Get IP address of the provider of this tweet
            let providerIp = await this.getProviderIp(this.lapi.client, tweetId)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)

            // Get tweet data from Mimei. Its definition is different from this app.
            let tweetInDB = await providerClient.RunMApp("get_tweet", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweetId,
                userid: "0000000000000000000000000000000",  // just a placeholder
            })
            console.log(tweetInDB)
            // get author data of the tweet.
            let author = await this.getUser(tweetInDB.authorId)
            if (!author) return

            let tweet = {
                mid: tweetInDB.mid,
                timestamp: tweetInDB.timestamp,
                author: author,
                content: tweetInDB.content,
                attachments: tweetInDB.attachments?.map((e: string) => {
                    return this.getMediaUrl(e, "http://" + providerIp)
                }),
                comments: [],
                originalTweetId: tweetInDB.originalTweetId,
                provider: providerIp
            }
            this.tweets.push(tweet)
            return tweet
        },

        async getUser(userId: string): Promise<User | undefined> {
            // check if the user has been retrieved.
            let author = this.authors.find(e => { e.mid == userId })
            if (author) return author

            let providerIp = await this.getProviderIp(this.lapi.client, userId)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)

            author = await providerClient.RunMApp("get_user_core_data", {
                aid: this.lapi.appId,
                ver: "last",
                userid: userId,
            })
            // cache the user data
            if (author) {
                author.provider = providerIp
                author.client = providerClient
                author.avatar = this.getMediaUrl(author.avatar, "http://" + providerIp)
                this.authors.push(author)
            }
            return author
        },

        // Given a mimie Id, find IP of its best provider
        async getProviderIp(client: any, mid: string): Promise<string | undefined> {
            return await client.RunMApp("get_provider", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid,
            })
        },

        async loadComments(tweet: Tweet) {
            if (!tweet.provider) return

            let client = this.lapi.getClient(tweet.provider)
            let comments = client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweet.mid,
                userid: "00000000000000000000000000",
            }) as any[]
            // comment type if a different Tweet type from the definition in this app
            comments.forEach(async e => {
                let author = await this.getUser(e.authorId)
                if (author) {
                    tweet.comments?.push({
                        mid: e.mid,
                        author: author,
                        content: e.content,
                        timestamp: e.timestamp,
                        attachments: e.attachments.map((a: string) => {
                            return this.getMediaUrl(a, "http://" + tweet.provider)
                        })
                    })
                }
            })
        },

        getMediaUrl(mid: string | undefined, baseUrl: string): string {
            let url = baseUrl
            if (!mid) {
                return "https://en.numista.com/catalogue/photos/essos/64a16406c47562.49601462-original.jpg"
            }
            return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
        },
    }
});