import { defineStore } from 'pinia';
import { useLeitherStore } from './leitherStore';
const GUEST_ID = "000000000000000000000000000"
const THIRTY_DAYS = 25920000000

export const useTweetStore = defineStore('tweetStore', {
    state: () => ({
        tweets: [] as Tweet[],
        authors: [] as User[],
        followings: ["uTE6yhCWGLlkK6KGI9iMkOFZGGv", "q10ggWF2ElEdc5OkIpAfWp0gDF9"],
        lapi: useLeitherStore(),
        appId: import.meta.env.VITE_MIMEI_APPID,
    }),
    getters: {
        loginUser: () => {
            let u = sessionStorage.getItem("user")
            if (u)
                return JSON.parse(u)
            else return null
        },
        loginUserId: () => {
            let u = sessionStorage.getItem("user")
            if (u)
                return JSON.parse(u).mid
            else return null
        }
    },
    actions: {
        // Load tweets of a list of followed User IDs
        async loadTweets(authorId: string | undefined = undefined) {

            // get userId list to get tweets from
            let followings = []
            if (authorId) {
                followings.push(authorId)
            } else {
                followings = this.followings
                if (this.loginUserId && followings.findIndex(e=> e==this.loginUserId)===-1) {
                   // add login user to following list
                    this.followings.unshift(this.loginUserId)
                }
            }

            followings.forEach(async uid => {
                let author = await this.getUser(uid)
                if (!author) return

                let tweetsByUser = await this.getTweetListByUser(author)
                if (!tweetsByUser || tweetsByUser.length==0) return

                // Each tweet does not have its author data yet.
                tweetsByUser.forEach(async tweet => {
                    // skip tweet that is in tweets already.
                    if (this.tweets.find(e => { e.mid == tweet.mid }))
                        return

                    tweet.author = author
                    tweet.provider = author.provider
                    tweet.attachments = tweet.attachments?.map(e => {
                        return {
                            mid: this.getMediaUrl(e.mid, "http://" + author.provider),
                            type: e.type
                        }
                    })
                    tweet.comments = []     // load comments only on detail page

                    if (tweet?.originalTweetId) {
                        let cachedTweet = sessionStorage.getItem(tweet?.originalTweetId)
                        if (cachedTweet) {
                            tweet.originalTweet = JSON.parse(cachedTweet)
                        } else {
                            let originTweet = await this.fetchTweet(tweet.originalTweetId)
                            tweet.originalTweet = originTweet
                            sessionStorage.setItem(originTweet?.mid!!, JSON.stringify(originTweet))
                        }
                    }
                    sessionStorage.setItem(tweet.mid, JSON.stringify(tweet))

                    // add the tweets into right location of tweets
                    let index = this.tweets.findIndex(e => { return e.timestamp!! < tweet.timestamp!! });
                    if (index === -1) {
                        // If no smaller timestamp is found, push to the end
                        this.tweets.push(tweet);
                    } else {
                        // Insert the tweet at the found index
                        this.tweets.splice(index, 0, tweet);
                    }
                })
            })
        },

        async getTweetListByUser(author: User): Promise<Tweet[] | undefined> {
            console.log(author)
            if (!author) return
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
            let tweet = await this.fetchTweet(tweetId)
            if (!tweet) return

            if (tweet?.originalTweetId) {
                tweet.originalTweet = await this.fetchTweet(tweet.originalTweetId)
            }
            sessionStorage.setItem(tweetId, JSON.stringify(tweet))
            return tweet
        },

        /**
         * Given tweet ID, get its content. There are 2 steps. First, find provider of
         * this tweet with its ID. 2nd, retrieve the tweet from the provider. Assume
         * author data is also available on the provider. Get author data too.
         */
        async fetchTweet(tweetId: string): Promise<Tweet | undefined> {
            let cachedTweet = sessionStorage.getItem(tweetId)
            if (cachedTweet) {
                return JSON.parse(cachedTweet)
            }
            // Get IP address of the provider of this tweet
            let providerIp = await this.getProviderIp(this.lapi.client, tweetId)

            console.log("fetchTweet provider", providerIp)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)

            // Get tweet data from Mimei. Its definition is different from this app.
            let tweetInDB = await providerClient.RunMApp("get_tweet", {
                aid: this.lapi.appId,
                ver: "last",
                tweetid: tweetId,
                userid: GUEST_ID,  // just a placeholder
            })
            if (!tweetInDB) return

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
                originalAuthorId: tweetInDB.originalAuthorId,
                provider: providerIp,
                likeCount: tweetInDB.likeCount,
                bookmarkCount: tweetInDB.bookmarkCount,
                commentCount: tweetInDB.commentCount
            }
            sessionStorage.setItem(tweetInDB.mid, JSON.stringify(tweet))
            return tweet
        },

        async getUser(userId: string): Promise<User | undefined> {
            // check if the user has been retrieved.
            let cachedUser = sessionStorage.getItem(userId)
            if (cachedUser) {
                let user = JSON.parse(cachedUser)
                user.client = this.lapi.getClient(user.provider)
                return user
            }
            let providerIp = await this.getProviderIp(this.lapi.client, userId)
            if (!providerIp) return
            let providerClient = this.lapi.getClient(providerIp)

            let user = await providerClient.RunMApp("get_user_core_data", {
                aid: this.appId,
                ver: "last",
                userid: userId,
            })
            // cache the user data
            if (user) {
                user.provider = providerIp
                user.client = providerClient
                user.avatar = this.getMediaUrl(user.avatar, "http://" + providerIp)
                sessionStorage.setItem(userId, JSON.stringify(user))
            }
            return user
        },

        // Given a mimie Id, find IP of its best provider
        async getProviderIp(client: any, mid: string): Promise<string | null> {
            let IPs = await client.RunMApp("get_provider", {
                aid: this.lapi.appId,
                ver: "last",
                mid: mid,
            })
            return findFirstAccessibleIP(IPs)
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
            if (!userId) return null
 
            let ips = await this.lapi.client.RunMApp("get_provider", {aid: this.appId,
                ver: "last", mid: userId
            })
            if (!ips || ips.length<1) return null

            console.log("IPs", ips)
            // ips is a list of available IP addresses, now find the best one.

            this.lapi.client = this.lapi.getClient(ips)
            let user = await this.lapi.client.RunMApp("login", {aid: this.appId, ver: "last",
                username: username, password: password, phrase: keyphrase
            })
            if (!user) return null
            
            user.avatar = this.getMediaUrl(user.avatar, "http://"+ips)
            sessionStorage.setItem("user", JSON.stringify(user))
            return user
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

async function findFirstAccessibleIP(ipList: string[]) {
    for (let ip of ipList) {
        try {
            const response = await fetch(`http://${ip}`, { method: 'HEAD', mode: 'no-cors' });
            if (response.ok || response.type === 'opaque') {
                console.log(`First accessible IP: ${ip}`);
                return ip;
            }
        } catch (error) {
            console.log(`IP ${ip} is not accessible.`);
        }
    }
    console.log('No accessible IP found.');
    return null;
}