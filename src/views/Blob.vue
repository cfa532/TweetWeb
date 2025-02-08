<script setup lang="ts">
import { onMounted } from 'vue';
import type { PropType } from 'vue'
import { useTweetStore } from "@/stores";

const props = defineProps({
    media: {type: Object as PropType<MimeiFileType>, required: true },
    tweet: {type: Object as PropType<Tweet>, required: false},
})
const tweetStore = useTweetStore()
const lastIndexOf = props.media.mid.lastIndexOf("/")
const mediaUrl = tweetStore.getMediaUrl(
    lastIndexOf > 0 ? props.media.mid.substring(lastIndexOf+1) : props.media.mid, 
    "http://"+props.tweet?.provider as string)
</script>

<template>
    <a href="#" @click.stop="tweetStore.downloadBlob(mediaUrl)">{{ media.fileName }}</a>
</template>

<style>
.container {
    /* text-align: left; */
    margin: 0px;

    /* float: left; */
    display: inline-block;
}
.container a {
    /* position:relative; */
    padding: 5px;
    display: block;
    max-width: 100%;
    width: 100%;
    height: auto;
}
</style>