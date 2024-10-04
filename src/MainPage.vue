<script setup lang="ts">
import { onMounted } from 'vue';
import { useTweetStore } from "@/stores/tweetStore";
import { TweetView } from "@/views"

const tweetStore = useTweetStore();
tweetStore.tweets = [
    {
        tweetId: "dfdghdfdbzdfbdrtndgrbsdfgserfva",
        user: {
            avatar: 'https://example.com/avatar.jpg',
            username: 'John Doe',
            alias: 'johndoe',
            profile: undefined,
        },
        content: 'This is a sample tweet content.',
        media: [
            'https://example.com/media1.jpg',
            'https://example.com/media2.jpg',
        ],
        timestamp: '2023-10-01T12:34:56Z',
    },
];
onMounted(()=> {
    console.log("Mainpage")
})
</script>

<template>
    <TweetView v-for="(tweet, index) in tweetStore.tweets" :tweet="tweet" :key="index" />
</template>

<style scoped>
</style>