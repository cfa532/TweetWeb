<script setup lang="ts">
import { onMounted, computed, ref } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';
import { useTweetStore } from '@/stores';
import { default as qrCoder } from "./QRCoder.vue"

const props = defineProps({ 
    author: {type: Object as PropType<User>, required: true},
    timestamp: {type: Number, required: false },
    isRetweet: {type: Boolean, required: false, default: false},
    by: {type: String, required: false}
})
const tweetStore = useTweetStore()
const router = useRouter()
const downloadApk = "9OCLYP-SXzen3e171-Ei_6N3Gwl"
const dlUrl = ref()
const qrSize = 60
const avatar = computed(()=>{
    let url = "http://" + props.author.providerIp
    let mid = props.author.avatar
    if (mid)
        return mid.length > 27 ? url + "/ipfs/" + mid : url + "/mm/" + mid
})

onMounted(async ()=>{
    let host = await tweetStore.getProviderIp(downloadApk)
    dlUrl.value = downloadApk.length>27? "http://" + host + "/ipfs/" + downloadApk 
        : "http://" + host + "/mm/" + downloadApk
})
function openUserPage(userId: string) {
    tweetStore.addFollowing(userId)
    router.push(`/author/${userId}`)
}
</script>

<template>
<div class="d-flex justify-content-between align-items-center" style="width: 100%;">
    <div class="d-flex align-items-center">
        <div class="avatar me-2">
            <img :src="avatar" alt="User Avatar" class="rounded-circle" 
                @click.stop="openUserPage(author.mid)">
        </div>
        <!-- User Info -->
        <div class="user-info flex-grow-1">
            <div v-if="isRetweet" class="label text-muted small">
                Forwarded by @{{ by }}
            </div>
            <!-- Username, Alias, and Time -->
            <div class="username-alias-time">
                <span class="username fw-bold">{{ author.name }}</span>
                <span class="alias text-muted">@{{ author.username }}</span>
            </div>
            <!-- Followers and Friends Links -->
            <div class="mt-1">
                <span v-if="props.timestamp" class="time text-muted">{{ formatTimeDifference(props.timestamp as
                    number) }}</span>
            </div>
        </div>
    </div>
    <div class="d-flex align-items-end">
        <button class='btn btn-link' @click="tweetStore.downloadApk">APP ⬇️
        </button>
        <div class="qr-code-container">
            <qrCoder v-if="dlUrl" :url="dlUrl" :size="qrSize"></qrCoder>
        </div>
    </div>
</div>
</template>

<style scoped>
.btn {
    font-size: 0.8rem;
}
.qr-code-container {
    width: 60px;
    height: 60px;
    display: flex;
    justify-content: center;
    align-items: center;
  }
.username {
  font-size: 0.9rem;
}
.alias {
  font-size: 0.9rem;
}
.avatar {
  display: flex;
  align-items: center; /* Ensures the avatar is vertically centered */
}
.avatar img {
  object-fit: cover;
  width: 40px;
  height: 40px;
  cursor: pointer;
}
.user-info {
  font-size: 0.8rem;
  flex-grow: 1; /* Allows the user info to take up remaining space */
}
.links a {
  color: #3d5563;
  text-decoration: none;
  font-size: 0.9rem;
}
.links a:hover {
  text-decoration: underline;
}
</style>