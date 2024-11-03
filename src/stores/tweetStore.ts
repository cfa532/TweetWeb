import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';
const GUEST_ID = "000000000000000000000000000"
const THIRTY_DAYS = 25920000000

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],
        authors: [] as User[],
        followings: ["q10ggWF2ElEdc5OkIpAfWp0gDF9"],
        // followings: ["uTE6yhCWGLlkK6KGI9iMkOFZGGv", "q10ggWF2ElEdc5OkIpAfWp0gDF9"],
        lapi: useLeitherStore(),
        appId: import.meta.env.VITE_MIMEI_APPID,
    }),
    getters: {
        user: () => {
            let u = sessionStorage.getItem("user")
            if (u)
                return JSON.parse(u)
            else return null
        },
        userId: () => {
            let u = sessionStorage.getItem("user")
            if (u)
                return JSON.parse(u).mid
            else return null
        }
    },
    actions: {
        // Load tweets of a list of followed User IDs
        async loadTweets(authorId: string | undefined = undefined) {
            let followings = []
            if (authorId) {
                followings.unshift(authorId)    // given userId, load its tweets
            } else {
                followings = this.followings
                if (this.userId && followings.findIndex(e=> e==this.userId)===-1) {
                   // add login user to following list
                    this.followings.unshift(this.userId)
                }
            }
            followings.forEach(async uid => {
                let author = await this.getUser(uid)
                if (!author) return
                let tweetsByUser = await this.getTweetListByUser(author)
                if (!tweetsByUser || tweetsByUser.length==0) return

                // Each tweet does not have its author data yet.
                tweetsByUser.forEach(async tit => {
                    // skip tweet that is in tweets already.
                    if (this.tweets.find(e => { e.mid == tit.mid }))
                        return
                    tit.author = author
                    tit.provider = author.provider
                    tit.attachments = tit.attachments?.map(e => {
                        return {
                            mid: this.getMediaUrl(e.mid, "http://" + author.provider),
                            type: e.type
                        }
                    })
                    tit.comments = []

                    // add the tweets into cached buffer
                    let index = this.tweets.findIndex(e => { return e.timestamp!! < tit.timestamp!! });
                    if (index === -1) {
                        // If no smaller timestamp is found, push to the end
                        this.tweets.push(tit);
                    } else {
                        // Insert the tweet at the found index
                        this.tweets.splice(index, 0, tit);
                    }
                })
            })
        },

        async getTweetListByUser(author: User): Promise<Tweet[] | undefined> {
            return await author.client.RunMApp("get_tweets", {
                aid: this.appId,
                ver: "last",
                userid: author.mid,
                start: Date.now(),
                end: Date.now() - THIRTY_DAYS,
                gid: GUEST_ID      // visitor's mid. Placeholder
            })
        },

        /**
         * Given only tweet ID, find it full data. Do NOT load comments yet. Wait until user opens
         * detail tweet page.
         * @param tweetId 
         * @param authorId not used
         * @returns a Tweet object short of comments.
         */
        async getTweet(tweetId: string, authorId: string | undefined = undefined): Promise<Tweet | undefined> {
            let tweet = this.tweets.find(t => { t.mid == tweetId })
            if (tweet) {
                return tweet
            }
            tweet = await this.fetchTweet(tweetId)
            if (!tweet) return

            if (tweet?.originalTweetId && this.tweets.findIndex(e=> e.mid==tweet?.originalTweetId)==-1) {
                let originTweet = await this.fetchTweet(tweet.originalTweetId)
                if (originTweet) this.tweets.push(originTweet)
            }
            this.tweets.push(tweet)
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
            return tweet
        },

        async getUser(userId: string): Promise<User | undefined> {
            // check if the user has been retrieved.
            let author = this.authors.find(e => { e.mid == userId })
            if (author) {
                console.log("Cached user", author)
                return author
            }
            let providerIp = await this.getProviderIp(this.lapi.client, userId)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)

            author = await providerClient.RunMApp("get_user_core_data", {
                aid: this.appId,
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

        async login(username: string, password: string, keyphrase: string) {
            let userId = await this.lapi.client.RunMApp("get_userid", {aid: this.appId,
                ver: "last", phrase: keyphrase
            })
            if (userId) {
                let ips = await this.lapi.client.RunMApp("get_provider", {aid: this.appId,
                    ver: "last", mid: userId
                })
                console.log("IPs", ips)
                this.lapi.client = this.lapi.getClient(ips)
                let user = await this.lapi.client.RunMApp("login", {aid: this.appId, ver: "last",
                    username: username, password: password, phrase: keyphrase
                })
                user.avatar = this.getMediaUrl(user.avatar, "http://"+ips)
                sessionStorage.setItem("user", JSON.stringify(user))
                return user
            }
            return null
        },
        logout() {
            sessionStorage.removeItem("user")
        },
        async openTempFile() {
            return await this.lapi.client.RunMApp("open_temp_file", {
                aid: this.appId, ver: "last"
            })
        },
        async uploadTweet(tweet: any) {
            let u = sessionStorage.getItem("user")
            if (!u) return null
            let user = JSON.parse(u) as User
            tweet.authorId = user.mid
            let t = await this.lapi.client.RunMApp("upload_tweet", 
                {aid: this.appId, ver: "last", tweet: JSON.stringify(tweet)})
            return t
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