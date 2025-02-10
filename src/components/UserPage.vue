<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";
import { TweetView, AppHeader } from "@/views"

const route = useRoute();
const authorId = computed(()=>route.params.authorId as MimeiId)
const tweetStore = useTweetStore();
const isLoading = ref(false)

onMounted(async () => {
    if (sessionStorage["isBot"] != "No") {
        if (confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!")) {
            sessionStorage["isBot"] = "No"
            loadTweets()
        } else {
            history.go(-1)
        }
    } else {
        loadTweets()
    }
})
async function loadTweets() {
    isLoading.value = true
    await tweetStore.loadTweets(authorId.value)
    isLoading.value = false
}
const tweetFeed = computed(()=>{
    return tweetStore.tweets.filter(e => {
    if (e.isPrivate) {
        return tweetStore.loginUser?.mid == e.authorId && e.authorId == authorId.value
    } else {
        return e.authorId == authorId.value
    }
})})
watch(authorId, async (nv, ov)=>{
    if (nv && nv!==ov) {
        isLoading.value = true
        await tweetStore.loadTweets(authorId.value)
        isLoading.value = false
    }
})
</script>

<template>
<div class="row justify-content-start align-items-start">
<div class="col-sm-12 col-md-8 col-lg-6" style="background-color:aliceblue;">
    <AppHeader :userId=authorId />
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