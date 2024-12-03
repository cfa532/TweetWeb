<script setup lang="ts">
import { onMounted, ref } from "vue";
import QRCodeStyling from 'qr-code-styling';
import { useTweetStore } from "@/stores";

const props = defineProps({
  url: {type: String, required: true},
  size: {type: Number, required: false, default: 200}
})
const icon = ref("http://"+useTweetStore().lapi.hostIP+"/mm/xmzaZPI_0CHL4hWGJukqC6yyGyW")
console.log(icon.value)

const qrCode = new QRCodeStyling({
        width: props.size,
        height: props.size,
        type: "svg",
        data: props.url,
        image: icon.value,
        dotsOptions: {
            color: "#4267b2",
            type: "rounded"
        },
        backgroundOptions: {
            color: "#ffffff",
        },
        imageOptions: {
            crossOrigin: "anonymous",
            margin: 0
        }
    });
  onMounted(()=> {
    qrCode.append(document.getElementById("canvas")!!)
  })
</script>

<template>
  <div id="canvas"></div>
</template>