<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';

const props = defineProps({ 
    tweet: {type: Object as PropType<Tweet>, required: true},
    isRetweet: {type: Boolean, required: false},
    by: {type: String, required: false}
})
const router = useRouter()
const avatar = ref()

onMounted(()=>{
    let url = "http://" + props.tweet.author.providerIp
    let mid = props.tweet.author.avatar
    if (mid)
        avatar.value = mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
})
function openUserPage(userId: string) {
    useTweetStore().addFollowing(userId)
    router.push(`/author/${userId}`)
}
</script>
<template>
    <img :src="avatar" alt="User Avatar" class="rounded-circle me-2"
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