<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { PropType } from 'vue'

const props = defineProps({
  media: { type: Object as PropType<MimeiFileType>, required: true },
  autoplay: { type: Boolean, required: false },
  controls: { type: String, required: false },
})

const caption = ref();
const vdiv = ref();
const video = ref();
const isPlaying = ref(false);
const isPortrait = ref(false);

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

function checkVideoOrientation() {
  const videoElement = video.value;
  if (videoElement.videoWidth < videoElement.videoHeight) {
    isPortrait.value = true;
  } else {
    isPortrait.value = false;
  }
}

function disableRightClick(event: MouseEvent) {
  if (props.controls)
    event.preventDefault();
}
</script>

<template>
  <div ref="vdiv" hidden class="video-container">
    <div v-if="isPortrait" class="custom-controls">
      <button @click.stop="togglePlay">
        <font-awesome-icon :icon='isPlaying ? "pause" : "play"' />
      </button>
      <!-- Add more custom control buttons as needed -->
    </div>
    <video
      ref="video"
      class="video"
      :src=props.media.mid
      :autoplay=props.autoplay
      controls
      :controlslist=props.controls 
      preload="auto"
      @loadedmetadata="checkVideoOrientation"
      @contextmenu="disableRightClick"
    ></video>
    <p style="margin-top: 5px; font-size: small; color: darkslategray; left: 15%; position: relative;">
      {{ caption }}
    </p>
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
  background: rgba(0, 0, 0, 0.2);
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