import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';

export const useTweetListStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],
        authors: [] as User[],
        fullowings: ["yifT_a-gWN9-JXsJ6P7gqizKMDM", "agvvgWJmmXtji5FLTt768Plu3He"],
        lapi: useLeitherStore(),
    }),
    actions: {
        async loadTweets() {
            this.fullowings.forEach(async uid=>{
                let author = await this.getUser(uid)
                if (!author) return
                let ts = await this.getTweetListByUserId(uid)
                if (!ts) return
                ts.forEach(async t=>{
                    if (this.tweets.find(e=>{e.mid==t.mid}))
                        return
                    t.author = author
                    if (t.originalTweetId) {
                        t.originalTweet = await this.getTweet(t.originalTweetId)
                        if (t.originalTweet)
                            t.originalAuthor = t.originalTweet.author
                    }
                    this.tweets = this.tweets.concat(t)
                })
            })
        },
        async getTweetListByUserId(authorId: string): Promise<Tweet[] | undefined> {
            // Get IP address of the provider of this user
            let providerIp = await this.getProviderIp(this.lapi.client, authorId)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)

            return await providerClient.RunMApp("get_tweets", {
                aid: this.lapi.appId,
                ver: "last",
                userid: authorId,
                start: Date.now(),
                end: Date.now() - 2592000000
            })
        },
        async getTweet(tweetId: string): Promise<Tweet | undefined> {
            let tweet = await this.fetchTweet(tweetId)
            if (!tweet) return
            let orig
            if (tweet?.originalTweetId) {
                orig = await this.fetchTweet(tweet.originalTweetId)
                tweet.originalTweet = orig
                tweet.originalAuthor = orig?.author
            }
            return tweet
        },

        // Given tweet ID, get its content. There are 2 steps. First, find provider of
        // this tweet with its ID. 2nd, retrieve the tweet from the provider. Assume
        // author data is also available on the provider. Get author data too.
        async fetchTweet(tweetId: string): Promise<Tweet | undefined> {
            let tweet = this.tweets.find(t=>{ t.mid == tweetId})
            if (tweet) return tweet

            // Get IP address of the provider of this tweet
            let providerIp = await this.getProviderIp(this.lapi.client, tweetId)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)

            // Get tweet data from Mimei
            let t = await providerClient.RunMApp("get_tweet", {
                aid: this.lapi.appId,
                ver: "last",
                tweetId: tweetId,
                userId: "0000000000000000000000000000000",  // just a placeholder
            })
            // get author data of the tweet. Assume it is on the same provider.
            let author = await this.getUser(t.authorId)
            if (!author) return
            tweet = {
                mid : t.mid,
                author : author,
                content : t.content,
                attachments : t.attachments?.map((e:string)=>{
                    return this.getMediaUrl(e, "http://"+providerIp)
                }),
                originalTweetId : t.originalTweetId,
                client: providerClient
            }
            this.tweets.push(tweet)
            return tweet
        },

        async getUser(userId: string): Promise<User | undefined> {
            // check if the user has been retrieved.
            let author = this.authors.find(e=>{ e.mid == userId})
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
            if (author) this.authors.push(author)
            return author
        },
        async getProviderIp(client: any, mid: string): Promise<string | undefined> {
            return await client.RunMApp("get_provider", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid,
            })
        },
        async getComments(tweet: Tweet): Promise<Tweet[] | undefined> {
            let comments = tweet.client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweet.mid,
                userid: "00000000000000000000000000",
            }) as Tweet[]
            comments.forEach(async e=>{
                let c = await this.getTweet(e.mid)
                if (c)
                    tweet.comments?.push(c)
            })
            return
        },
        getMediaUrl(mid: string, baseUrl: string): string {
            let url = baseUrl
            return mid.length>27 ? url+"/ipfs/"+mid : url+"/mm/"+mid
        },
    }
});