<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTweetStore } from "@/stores/tweetStore";
import QRCode from 'qrcode';

const router = useRouter()
const tweetStore = useTweetStore()
const qrcodeCanvas = ref<HTMLCanvasElement>()

onMounted(()=>{
    if (sessionStorage["isBot"] != "No") {
        confirm("芝麻，开门！\nOpen Sesame!\n開け！ゴマ\nيا سمسم، افتح الباب!") ? sessionStorage["isBot"] = "No" : history.go(-1)
    }
    QRCode.toCanvas(qrcodeCanvas.value, window.location.href, {
         width: 128,
         color: {
           dark: '#000000',
           light: '#ffffff'
         }
       }, function (error) {
         if (error) console.error(error);
         console.log('QR code generated!');
       });
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
                <canvas ref="qrcodeCanvas"></canvas>
            </div>
        </div>
    </div>
</template>
<style scoped>
canvas {
    margin: 0px;
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