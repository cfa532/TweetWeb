<script setup lang="ts">
import { ref, onMounted } from 'vue';

const props = defineProps({
  mid: { type: String, required: false },
  type: { type: String, required: false },
  autoplay: { type: Boolean, required: false, default: false },
});

const caption = ref();
const vdiv = ref();
const video = ref();
const isPlaying = ref(false);

onMounted(() => {
  vdiv.value.hidden = false;
});

function togglePlay() {
  if (video.value.paused) {
    video.value.play();
    isPlaying.value = true;
  } else {
    video.value.pause();
    isPlaying.value = false;
  }
}
</script>

<template>
  <div ref="vdiv" hidden class="video-container">
    <div class="custom-controls">
      <button @click.stop="togglePlay">{{ isPlaying ? 'Pause' : 'Play' }}</button>
      <!-- Add more custom control buttons as needed -->
    </div>
    <video ref="video" class="video" :src="props.mid" :autoplay="props.autoplay" preload="auto"></video>
    <p style="margin-top: 5px; font-size: small; color: darkslategray; left: 15%; position: relative;">{{ caption }}</p>
  </div>
</template>

<style>
.video-container {
  position: relative;
  max-width: 100%;
}

.video {
  width: 100%;
  display: block;
}

.custom-controls {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  display: flex;
  justify-content: flex-start;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 5px;
  z-index: 10;
}

.custom-controls button {
  background: none;
  border: none;
  color: white;
  font-size: 16px;
  cursor: pointer;
  margin-right: 10px;
}

.custom-controls button:hover {
  text-decoration: underline;
}
</style>