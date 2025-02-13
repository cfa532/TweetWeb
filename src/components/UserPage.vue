<script setup lang='ts'>
import { computed, onMounted, ref, onUnmounted, watch } from 'vue';
import { useTweetStore } from '@/stores';
import { useRoute } from 'vue-router';
import { TweetView, AppHeader } from '@/views'

const tweetStore = useTweetStore();
const isLoading = ref(false);
const startRank = ref(0);
const scrollThreshold = 200; // Distance from bottom to trigger load
const initialLoad = ref(true);
const route = useRoute();
const authorId = computed(()=>route.params.authorId as MimeiId)
const pinnedTweets = ref<Tweet[]>()

// Debounce function (you can also use a library like lodash)
function debounce<T extends Function>(func: T, delay: number) {
    let timeout: any;
    return function(this: any, ...args: any[]) { // Explicitly define 'this' type
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

async function loadMoreTweets() {
    if (isLoading.value)
        return; // Prevent multiple loads
    isLoading.value = true;
    await tweetStore.loadTweetsByRank(authorId.value, startRank.value, 10);
    startRank.value += 10;
    isLoading.value = false;
}

const handleScroll = debounce(async () => {
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;

    if (documentHeight - scrollPosition < scrollThreshold) {
        await loadMoreTweets();
    }
}, 250); // Adjust debounce delay as needed

onMounted(async () => {
    if (sessionStorage['isBot'] != 'No') {
        if (confirm('芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!')) {
            sessionStorage['isBot'] = 'No'
            await loadTweets(authorId.value)
        } else {
            history.go(-1)
        }
    } else {
        await loadTweets(authorId.value)
    }
    window.addEventListener('scroll', handleScroll);
});

onUnmounted(() => {
    window.removeEventListener('scroll', handleScroll);
});

async function loadTweets(authorId: MimeiId) {
    if (isLoading.value)
        return; // Prevent multiple loads
    isLoading.value = true;

    await tweetStore.loadTweetsByRank(authorId, startRank.value, 10);
    tweetStore.tweets.sort((a: any, b: any) => b.timestamp - a.timestamp);
    startRank.value += 10;
    initialLoad.value = false;

    // load pinned tweets and sort by timestamp
    pinnedTweets.value = await tweetStore.loadPinnedTweets(authorId)
    pinnedTweets.value?.sort((a :any, b :any) => (b.timestamp as number) - (a.timestamp as number))

    window.setTimeout(() => {
        isLoading.value = false;
    }, 2000);
}

const tweetFeed = computed(() => {
    return tweetStore.tweets.filter(e => {
        if (e.isPrivate) {
            return tweetStore.loginUser?.mid == e.authorId && e.authorId == authorId.value
        } else {
            return e.authorId == authorId.value
        }
    });
});

watch(authorId, async (nv, ov)=>{
    if (nv && nv!==ov) {
        startRank.value = 0;
        await loadTweets(nv)
    }
})
</script>

<template>
<div class="row justify-content-start align-items-start">
<div class="col-sm-12 col-md-8 col-lg-6" style="background-color:aliceblue;">
    <AppHeader :userId=authorId />
    <b v-if="pinnedTweets?.length!>0">&nbsp;&nbsp;Pinned</b>
    <TweetView v-for="tweet in pinnedTweets" :tweet="tweet" :key="tweet.mid" />
    <hr />
    <b v-if="pinnedTweets?.length!>0">&nbsp;&nbsp;Tweets</b>
    <TweetView v-for="tweet in tweetFeed" :tweet="tweet" :key="tweet.mid" />
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</div>
</div>
</template>

<style scoped>
</style>