import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';
const GUEST_ID = "000000000000000000000000000"

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],
        authors: [] as User[],
        followings: ["uTE6yhCWGLlkK6KGI9iMkOFZGGv", "q10ggWF2ElEdc5OkIpAfWp0gDF9"],
        lapi: useLeitherStore(),
        appId: import.meta.env.VITE_MIMEI_APPID,
    }),
    actions: {
        async login(username: string, password: string, keyphrase: string) {
            let user = await this.lapi.client.RunMApp("login", {aid: this.appId, ver: "last",
                username: username, password: password, phrase: keyphrase
            })
            return user
        },
        async openTempFile() {
            return await this.lapi.client.RunMApp("open_temp_file", {
                aid: this.appId, ver: "last"
            })
        },
        async uploadTweet(tweet: any) {
            let u = sessionStorage.getItem("userId")
            if (!u) return null
            let user = JSON.parse(u) as User
            tweet.authorId = user.mid
            let t = await this.lapi.client.RunMApp("upload_tweet", 
                {aid: this.appId, ver: "last", tweet: JSON.stringify(tweet)})
            console.log("new tweet", t)
            return t
        },
        // Load tweets of a list of followed User IDs
        async loadTweets(authorId: string | undefined = undefined) {
            this.tweets = []
            if (authorId && !this.followings.find(e => e==authorId)) {
                this.followings.unshift(authorId) 
            }
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
                        return {
                            mid: this.getMediaUrl(e.mid, "http://" + author.provider),
                            type: e.type
                        }
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
                end: Date.now() - 2592000000,
                gid: GUEST_ID      // visitor's mid
            })
        },

        // Given only tweet ID, find it full data.
        async getTweet(tweetId: string, authorId: string | undefined = undefined): Promise<Tweet | undefined> {
            let tweet = this.tweets.find(t => { t.mid == tweetId })
            if (tweet) {
                return tweet
            }
            tweet = await this.fetchTweet(tweetId)
            console.log(tweet, tweetId)
            if (!tweet) return

            if (tweet?.originalTweetId) {
                let orig = await this.fetchTweet(tweet.originalTweetId)
                tweet.originalTweet = orig
                tweet.originalAuthor = orig?.author
            }
            return tweet
        },

        /**
         * Given tweet ID, get its content. There are 2 steps. First, find provider of
         * this tweet with its ID. 2nd, retrieve the tweet from the provider. Assume
         * author data is also available on the provider. Get author data too.
         */
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
                userid: GUEST_ID,  // just a placeholder
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
                attachments: tweetInDB.attachments?.map((e: MimeiFileType) => {
                    e.mid = this.getMediaUrl(e.mid, "http://" + providerIp)
                    return e
                }),
                comments: [],
                originalTweetId: tweetInDB.originalTweetId,
                provider: providerIp,
                likeCount: tweetInDB.likeCount,
                bookmarkCount: tweetInDB.bookmarkCount,
                commentCount: tweetInDB.commentCount
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
            if (!tweet || !tweet.provider) return

            let client = this.lapi.getClient(tweet.provider)
            let comments = await client.RunMApp("get_comments", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweet.mid,
                userid: GUEST_ID,
            }) as any[]
            // comment type is a different Tweet type from the definition in this app
            comments.sort((a, b) => b.timestamp - a.timestamp)
            comments.forEach(async e => {
                let author = await this.getUser(e.authorId)
                if (author) {
                    tweet.comments?.push({
                        mid: e.mid,
                        author: author,
                        content: e.content,
                        timestamp: e.timestamp,
                        attachments: e.attachments?.map((a: MimeiFileType) => {
                            // comments on same node with tweet.
                            a.mid = this.getMediaUrl(a.mid, "http://" + tweet.provider)
                            return a
                        }),
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

        async downloadApk() {
            let url = await this.lapi.client.RunMApp("download_upgrade", {
                aid: this.lapi.appId, ver:"last"}
            )
            if (!url) return
            fetch(url)
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Network response was not ok');
                    }
                    return response.blob(); // Convert the response to a Blob
                })
                .then(blob => {
                    const link = document.createElement('a');
                    link.href = window.URL.createObjectURL(blob);
                    link.download = 'downloaded-file.apk';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                })
                .catch(error => {
                    console.error('There was a problem with the fetch operation:', error);
                });
        }
    }
});