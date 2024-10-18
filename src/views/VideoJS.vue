<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  mid: {type:String, required: false},
  type: {type:String, required: false},
  autoplay: {type: Boolean, required: false, default: false},
});
const caption = ref()
const vdiv = ref()  // to deal with a bug sometime player do not hide when switching components in parent Vue

onMounted(async () => {
  console.log("Videoplayer mounted", props)
  vdiv.value.hidden = false;
})
</script>

<template>
  <div ref="vdiv" hidden>
    <video class="video" v-if="props.type === 'Video'" :src="props.mid" :autoplay="props.autoplay" controls preload="auto"></video>
    <audio v-else :src="props.mid" :autoplay="props.autoplay" controls class="audio" preload="auto"></audio>
    <p style="margin-top: 5px; font-size: small; color: darkslategray; left: 15%; position: relative;">{{ caption }}</p>
  </div>
</template>

<style>
.video {
  max-width: 100%;
}

.audio {
  width: 100%;
  max-width: 500px;
  height: 40px;
  background-color: transparent !important;
}
</style>