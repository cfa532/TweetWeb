<script setup lang="ts">
import { onMounted, ref } from "vue";
// import QRCodeVue3 from "qrcode-vue3";
import QRCodeStyling from 'qr-code-styling';

const props = defineProps({
  url: {type: String, required: true},
  size: {type: Number, required: false, default: 200}
})
const icon = ref("/src/ic_splash.png")
const qrCode = new QRCodeStyling({
        width: props.size,
        height: props.size,
        type: "svg",
        data: props.url,
        // image: icon.value,
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