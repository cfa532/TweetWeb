<script lang="ts" setup>
import { watch, onMounted, ref, computed } from 'vue';
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { useTweetStore, useLeitherStore } from "@/stores";
import { default as qrCoder } from "./QRCoder.vue"
import { formatTimeDifference } from '@/lib';

const router = useRouter()
const tweetStore = useTweetStore()
const downloadApk = "9OCLYP-SXzen3e171-Ei_6N3Gwl"
const dlUrl = ref()
const qrSize = 60
const props = defineProps({
    userId: {type: String, required: false},
})
const userId = computed(()=>props.userId)
const avatarUrl = ref()
const user = ref<User>()

onMounted(async ()=>{
    if (sessionStorage["isBot"] != "No") {
        confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
    let host = await tweetStore.getProviderIp(downloadApk)
    dlUrl.value = downloadApk.length>27? "http://" + host + "/ipfs/" + downloadApk 
        : "http://" + host + "/mm/" + downloadApk
    avatarUrl.value = await useLeitherStore().logoUrl

    if (props.userId) {
        user.value = await tweetStore.getUser(props.userId)
        tweetStore.getFollowCount(props.userId)   // No need to await here.
    }
})
watch(userId, async (nv, ov)=>{
    if (nv !== ov) {
        if (nv) {
            user.value = await tweetStore.getUser(nv)
            tweetStore.getFollowCount(nv)
            console.log(user.value)
        }
        else {
            user.value = undefined
        }
    }
})
</script>

<template>
<div class="row mb-2">
    <div class="d-flex justify-content-between">
        <div class="d-flex">
            <div class="avatar me-2 ms-2 mt-1">
                <img v-if="user" :src="user.avatar" @click="router.push({name:'main'})" alt="Logo" class="rounded-circle" />
                <img v-else :src="avatarUrl" @click="router.push({name:'main'})" alt="Logo" class="rounded-circle" />
            </div>
            <!-- User Info -->
            <div v-if="user" class="user-info flex-grow-1">
                <!-- Username, Alias, and Time -->
                <div class="username-alias-time">
                    <span class="username fw-bold">{{ user.name }}</span>
                    <span class="alias text-muted">@{{ user.username }}</span>
                    <span class="time text-muted"> - {{ formatTimeDifference(user.timestamp as number) }}</span>
                </div>
                <!-- Followers and Friends Links -->
                <div class="links mt-1">
                    <a href="#" @click.prevent="router.push(`/followers/${user.mid}`)" class="me-2 text-muted">{{ user.followerCount }} fans</a>
                    <a href="#" @click.prevent="router.push(`/followings/${user.mid}`)" class="text-muted">{{ user.followingCount }} following</a>
                </div>

                <div class="mt-1">
                    <span class="alias text-muted">{{ user.profile }}</span>
                </div>
            </div>
        </div>
        <div class="d-flex align-items-start qr-container">
            <button class='btn btn-link' @click="tweetStore.downloadApk">APP ⬇️</button>
            <div class="qr-code-container">
                <qrCoder v-if="dlUrl" :url="dlUrl" :size="qrSize"></qrCoder>
            </div>
        </div>
    </div>
</div>
</template>

<style scoped>
.qr-container {
    display: flex;
    align-items: flex-end; /* Aligns items to the right */
}
.btn {
    font-size: 0.8rem;
}
.qr-code-container {
    display: flex;
    justify-content: center;
    align-items: center;
}
.d-flex {
    margin: 2px 0px;
    display: flex;
    align-items: center; /* Aligns items vertically centered */
    justify-content: space-between; /* Ensures space between elements */
    flex-wrap: nowrap; /* Prevents wrapping of the QR code */
}
.avatar img {
    object-fit: cover;
    width: 60px;
    height: 60px;
    cursor: pointer;
    transition: width 0.3s, height 0.3s; /* Smooth transition for size changes */
}
.user-info {
    flex-grow: 1; /* Allows the user info to take up remaining space */
    margin-left: 10px; /* Adds some space between avatar and user info */
    flex-wrap: wrap; /* Allows text to wrap on smaller screens */
}
.username-alias-time {
    display: flex;
    align-items: center;
    gap: 1px;
    flex-wrap: wrap; /* Allows text to wrap on smaller screens */
    font-size: 0.95rem;
}
.text-muted {
    font-size: 0.95rem;
}
.links a {
    color: #3d5563;
    text-decoration: none;
    font-size: 0.9rem;
    margin-right: 10px; /* Adds space between links */
}
.links a:hover {
    text-decoration: underline;
}

@media (max-width: 600px) {
    .qr-container {
        flex-direction: column; /* Changes direction to column on small screens */
        align-items: center; /* Centers items horizontally */
    }
    .btn {
        font-size: 0.7rem;
    }
    .avatar img {
        width: 50px;
        height: 50px;
    }
    .user-info {
        line-height: 1.2;
        flex-grow: 1;
        margin-left: 1px; /* Adjusts margin for smaller screens */
    }
    .username-alias-time {
        gap: 2px; /* Reduces gap for smaller screens */
    }
    .links a {
        font-size: 0.9rem; /* Reduces font size for smaller screens */
    }
}

@media (min-width: 1200px) {
    .avatar img {
        width: 60px;
        height: 60px;
    }
    .user-info {
        margin-left: 1px; /* Increases margin for larger screens */
    }
}
</style>