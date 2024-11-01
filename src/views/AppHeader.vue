<script lang="ts" setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";

const router = useRouter()
const tweetStore = useTweetStore()
onMounted(()=>{
    if (sessionStorage["isBot"] != "No") {
        confirm("芝麻，开门！") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
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
                <button class='btn btn-primary col-md-auto me-2' @click="tweetStore.downloadApk">下载App</button>
                <img src="/src/tweet_QR.png" alt="QR Code" class="qr-code" />
            </div>
        </div>
    </div>
</template>
<style>
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