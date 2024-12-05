<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";
import { default as qrCoder } from "./QRCoder.vue"
import { formatTimeDifference } from '@/lib';

const router = useRouter()
const tweetStore = useTweetStore()
const downloadApk = "9OCLYP-SXzen3e171-Ei_6N3Gwl"
const dlUrl = ref()
const qrSize = 100
const props = defineProps({
    user: {type: Object as PropType<User>, required: false},
})
const iconUrl = computed(()=>{
    if (props.user) {
        console.log(props.user)
        let mid = props.user.avatar!
        return "http://"+props.user.providerIp+ (mid.length > 27 ? "/ipfs/" + mid : "/mm/" + mid)
    } else {
        return "/src/tweet_icon.png"
    }
})
onMounted(async ()=>{
    console.log(props.user)
    if (sessionStorage["isBot"] != "No") {
        confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
    let host = await tweetStore.getProviderIp(downloadApk)
    dlUrl.value = downloadApk.length>27? "http://" + host + "/ipfs/" + downloadApk 
        : "http://" + host + "/mm/" + downloadApk

    if (props.user) {
        tweetStore.getFollowCount(props.user)
    }
})
</script>

<template>
    <div class="row align-items-center mb-2">
        <div class="d-flex justify-content-between">
            <div class="d-flex">
                <div class="avatar me-2 ms-2 mt-1">
                    <img :src="iconUrl" @click="router.push({name:'main'})" alt="Logo" class="rounded-circle" />
                </div>
                <!-- User Info -->
                <div v-if="user" class="user-info flex-grow-1">
                    <!-- Username, Alias, and Time -->
                    <div class="username-alias-time">
                        <span class="username fw-bold">{{ user.name }}</span>
                        <span class="alias text-muted">@{{ user.username }}</span>
                        <span class="time text-muted"> - {{ formatTimeDifference(user.timestamp as number) }}</span>
                    </div>
    
                    <div class="mt-1">
                        <span class="alias text-muted">{{ user.profile }}</span>
                    </div>
                    <!-- Followers and Friends Links -->
                    <div class="links mt-1">
                        <a :href="`/followers/${user.mid}`" class="me-3">{{ user.followerCount }} fans</a>
                        <a :href="`/followings/${user.mid}`">{{ user.followingCount }} following</a>
                    </div>
                </div>
            </div>
            <div class="d-flex align-items-center">
                <button class='btn btn-link' @click="tweetStore.downloadApk">App ⬇️
                </button>
                <qrCoder v-if="dlUrl" :url="dlUrl" :size="qrSize"></qrCoder>
            </div>
        </div>
    </div>
</template>

<style scoped>
.d-flex {
    display: flex;
    align-items: center; /* Aligns items vertically centered */
}

.avatar {
    display: flex;
    align-items: center; /* Ensures the avatar is vertically centered */
}

.avatar img {
    object-fit: cover;
    width: 80px;
    height: 80px;
    cursor: pointer;
}

.user-info {
    line-height: 1.2;
    flex-grow: 1; /* Allows the user info to take up remaining space */
}

.username-alias-time {
    display: flex;
    align-items: center;
    gap: 5px;
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