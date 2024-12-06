<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useTweetStore } from "@/stores";
import QrcodeVue from 'qrcode.vue'
import type { Level, RenderAs, GradientType, ImageSettings } from 'qrcode.vue'

const props = defineProps({
  url: { type: String, required: true },
  size: { type: Number, required: false },
  logoSize: { type: Number, required: false, default: 30 },
})

const level = ref<Level>('M')
const renderAs = ref<RenderAs>('svg')
const background = ref('#ffffff')
const foreground = ref('#088df8')
const margin = ref(0)

const imageSettings = ref<ImageSettings>({
  src: "http://" + useTweetStore().lapi.hostIP + "/mm/xmzaZPI_0CHL4hWGJukqC6yyGyW",
  width: props.logoSize,
  height: props.logoSize,
  // x: 10,
  // y: 10,
  excavate: false,
})

const gradient = ref(false)
const gradientType = ref<GradientType>('radial')
const gradientStartColor = ref('#000000')
const gradientEndColor = ref('#38bdf8')
onMounted(() => {
});
</script>

<template>
  <qrcode-vue
    :value=props.url
    :level="level"
    :render-as="renderAs"
    :background="background"
    :foreground="foreground"
    :gradient="gradient"
    :gradient-type="gradientType"
    :gradient-start-color="gradientStartColor"
    :gradient-end-color="gradientEndColor"
    :image-settings="imageSettings"
  />
</template>

<style scoped>
.qrcode-container {
  position: relative;
  width: 256px;
  height: 256px;
}

.logo {
  background-color: rgb(85, 137, 234);
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 50px;
  /* Adjust the size of the logo */
  height: 50px;
  display: none;
  /* Hide the image element */
}
</style>