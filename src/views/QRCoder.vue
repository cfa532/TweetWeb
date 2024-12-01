<script setup lang="ts">
import { onMounted, ref } from "vue";
import QRCodeVue3 from "qrcode-vue3";

const props = defineProps({
  url: {type: String, required: true},
  size: {type: Number, required: false, default: 200}
})
const icon = ref("/src/ic_splash.png")
</script>

<template>
  <QRCodeVue3
      :width=props.size
      :height=props.size
      :value=props.url
      :qrOptions="{ typeNumber: 0, mode: 'Byte', errorCorrectionLevel: 'H' }"
      :imageOptions="{ hideBackgroundDots: true, imageSize: 0.4, margin: 0 }"
      :dotsOptions="{
        type: 'dots',
        color: '##26249a',
        gradient: {
          type: 'linear',
          rotation: 0,
          colorStops: [
            { offset: 0, color: '#26249a' },
            { offset: 1, color: '#26249a' },
          ],
        },
      }"
      :backgroundOptions="{ color: '#ffffff' }"
      :cornersSquareOptions="{ type: 'dot', color: '#000000' }"
      :cornersDotOptions="{ type: undefined, color: '#000000' }"

  />
  </template>