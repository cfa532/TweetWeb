<script setup lang="ts">
import { onMounted } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import TweetDetail from '@/components/TweetDetail.vue';

const props = defineProps({ 
    tweet: {type: Object as PropType<Tweet>, required: true},
    isRetweet: {type: Boolean, required: false},
    by: {type: String, required: false}
})
const router = useRouter()
onMounted(()=>{
    // console.log("ItemHeader", props)
})
function openUserPage(userId: string) {
    router.push(`/author/${userId}`)
}
function imageUrl(mid?: MimeiId) {
    if (!mid) return
    let url = "http://" + props.tweet.author.providerIp
    return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
}
</script>
<template>
    <img :src="imageUrl(tweet.author.avatar)" alt="User Avatar" class="rounded-circle me-2"
        @click.stop="openUserPage(tweet.author.mid)">
    <div>
        <div class="forward-font" v-if="isRetweet">Forwarded by @{{by}}</div>
        <h6 class="mb-0">{{ tweet.author.name }}</h6>
        <small class="text-muted">@{{ tweet.author.username }} - {{
            formatTimeDifference(tweet.timestamp as number) }}</small>
    </div>
</template>
<style>
.rounded-circle {
    width: 40px;
    height: 40px;
    cursor: pointer
}
.forward-font {
    font-size: smaller;
    opacity: 0.8;
}
</style>