<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";
import { default as qrCoder } from "./QRCoder.vue"

const router = useRouter()
const tweetStore = useTweetStore()
const downloadApk = "9OCLYP-SXzen3e171-Ei_6N3Gwl"
const dlUrl = ref()
const qrSize = 120

onMounted(async ()=>{
    if (sessionStorage["isBot"] != "No") {
        confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
    let host = await tweetStore.getProviderIp(downloadApk)
    dlUrl.value = downloadApk.length>27? "http://" + host + "/ipfs/" + downloadApk 
        : "http://" + host + "/mm/" + downloadApk
})
</script>
<template>
    <div class="row align-items-center mb-1">
        <div class="d-flex justify-content-between">
            <div>
                <img src="/src/tweet_icon.png" @click="router.push({name:'main'})" alt="Logo" 
                class="app-icon rounded-circle" />
            </div>
            <div class="d-flex align-items-center">
                <button class='btn btn-link' @click="tweetStore.downloadApk">⬇️ App
                </button>
                <qrCoder v-if="dlUrl" :url="dlUrl" :size="qrSize"></qrCoder>
            </div>
        </div>
    </div>
</template>
<style scoped>
.d-flex.align-items-center {
    position: relative;
    height: 100px; /* Adjust the height as needed */
}

.btn {
    position: absolute;
    bottom: 0;
    right: 100px;
    width: 100px;
    vertical-align: bottom;
}
.app-icon {
    margin: 16px 0 0 16px;
    width: 80px !important;
    height: 80px !important;
    cursor: pointer;
}
.rounded-circle {
    width: 40px;
    height: 40px;
}
.qr-code {
    width: 100px !important;
    height: 100px !important;
}
</style>