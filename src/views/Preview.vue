<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
const emit = defineEmits(["fileCanceled", "dragStart", "dragOver", "dragLeave", "drop", "dragEnd"])
const props = defineProps({
    src: {type: File, required: true},
    progress: {type: Number, required: false, default:100},     // uploading progress bar
    dragged: {type: Boolean, required: false, default: false},  // whether this item is being dragged
    dragOver: {type: Boolean, required: false, default: false}, // whether this item is being dragged over
})
const imageUrl = ref("")
const caption = ref("")
onMounted(()=>{
    // src file may not be image
    console.log("progress=", props.progress)
    thumbnail()
})
watch(()=>props.src, (newVal, oldVal)=>{
    if (newVal !== oldVal) {
        thumbnail()
    }
})
function cancel() {
    emit("fileCanceled")
}

// Drag and drop event handlers
function onDragStart(e: DragEvent) {
    emit("dragStart")
    e.dataTransfer!.effectAllowed = 'move'
}

function onDragOver(e: DragEvent) {
    emit("dragOver", e)
}

function onDragLeave(e: DragEvent) {
    emit("dragLeave")
}

function onDrop(e: DragEvent) {
    emit("drop", e)
}

function onDragEnd(e: DragEvent) {
    emit("dragEnd")
}
function thumbnail() {
    if (props.src.type.includes("image")) {
        imageUrl.value = URL.createObjectURL(props.src)
        caption.value = props.src.name
    } else if (props.src.type.includes("video")) {
        generateVideoThumbnail(props.src).then(url=>{
            imageUrl.value = url
            caption.value = props.src.name
        })
    } else {
        // everything else, draw avtar with file extensioin
        const canvas = document.createElement("canvas");
        let ctx = canvas.getContext("2d")!;
          canvas.width = 120;
          canvas.height = 120;
          ctx.font = '48px serif';
          ctx.fillText(props.src.name.substring(props.src.name.lastIndexOf('.')+1), 15, 60);
          imageUrl.value = canvas.toDataURL("image/png");
          caption.value = props.src.name
    }
}
const generateVideoThumbnail = (file: File) => {
  return new Promise<string>((resolve) => {
    const canvas = document.createElement("canvas");
    const video = document.createElement("video");

    // this is important
    video.autoplay = true;
    video.muted = true;
    video.src = URL.createObjectURL(file) + '#t=1';     // delay 1s
    video.onloadeddata = () => {
      let ctx = canvas.getContext("2d");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      // Log video dimensions and aspect ratio for thumbnail generation
      const aspectRatio = video.videoWidth / video.videoHeight;
      console.log(`🎬 [VIDEO THUMBNAIL] File: ${file.name}`);
      console.log(`📐 [VIDEO THUMBNAIL] Dimensions: ${video.videoWidth}x${video.videoHeight}`);
      console.log(`📐 [VIDEO THUMBNAIL] Aspect ratio: ${aspectRatio.toFixed(3)} (${getAspectRatioDisplayName(aspectRatio)})`);
      
      ctx!.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      video.pause();
      return resolve(canvas.toDataURL("image/png"));
    };
  });
};

// Helper function to get human-readable aspect ratio names
function getAspectRatioDisplayName(ratio: number): string {
  const tolerance = 0.01;
  if (Math.abs(ratio - (4/3)) < tolerance) return '4:3';
  if (Math.abs(ratio - (16/9)) < tolerance) return '16:9';
  if (Math.abs(ratio - (21/9)) < tolerance) return '21:9';
  if (Math.abs(ratio - (16/10)) < tolerance) return '16:10';
  if (Math.abs(ratio - (9/16)) < tolerance) return '9:16 (portrait)';
  if (Math.abs(ratio - 1) < tolerance) return '1:1 (square)';
  return `${ratio.toFixed(3)}:1`;
}
</script>

<template>
    <div 
        class="postbox_media_photo_wrapper" 
        :class="{
            'dragging': props.dragged,
            'drag-over': props.dragOver
        }"
        :style="{position: 'relative', opacity: props.progress === 100 ? 1 : 0.7}"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
    >
        <div style="position: absolute; display: flex; top: -5px; right: -5px; z-index: 20;">
            <button @click="cancel" title="Close" class="btn-reset" type="button">
            <svg style="width:20px; height:20px;">
                <circle cx="10" cy="10" r="10" stroke="black" stroke-width="0" fill="#d14e4e" />
                <line x1="5" y1="5" x2="15" y2="15" style="stroke:#fff;stroke-width:2"></line>
                <line x1="15" y1="5" x2="5" y2="15" style="stroke:#fff;stroke-width:2"></line>
            </svg>
            </button>
        </div>
        <div 
            class="postbox_media_photo_img_wrapper" 
            draggable="true"
            @dragstart="onDragStart"
            @dragend="onDragEnd"
        >
            <img :src="imageUrl" class="postbox_media_photo_img" draggable="false">
        </div>
        <div style="overflow:hidden; height:40px; position:absolute; bottom: 0px; left: 0px; padding: 5px 2px 0px 3px;">
            <div style="font-size:small; inline-size: 119px; overflow-wrap: break-word;">{{caption}}</div>
        </div>
        <div v-if="props.progress < 100" class="progress-bar-overlay">
            <div class="progress-bar" :style="{width: props.progress + '%', height: '10px', backgroundColor: 'green', borderRadius: '5px'}"></div>
        </div>
    </div>
</template>

<style>
.progress-bar-overlay {
    position: absolute;
    top: 50%;
    left: 0;
    width: 100%;
    height: 10px;
    transform: translateY(-50%);
    z-index: 100;
    background: rgba(255, 255, 255, 0.5);
  }
  .progress-bar {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    background-color: green;
    border-radius: 5px;
  }
  .postbox_media_photo_img_wrapper {
    top: 10px;
    position: absolute;
    display: flex;
    width: 100%;
    height: 120px;
    cursor: move;
    user-select: none;
    overflow: hidden;
    /* height: calc(100% - 32px); */
}

.postbox_media_photo_wrapper {
    height: 170px;
    width: 120px;
    position: relative;
    display: inline-block;
    background-color: #fff;
    border-radius: 3px;
    box-shadow: 0 1px 3px rgba(0,0,0,.1);
    transition: All .15s ease-out;
    /* max-width: calc(25% - 32px); */
    flex-grow: 1;
    margin-right: 15px;
    margin-top: 5px;
}

.postbox_media_photo_wrapper.dragging {
    opacity: 0.5;
    transform: rotate(5deg);
    z-index: 1000;
}

.postbox_media_photo_wrapper.drag-over {
    border: 2px dashed #007bff;
    background-color: #f8f9fa;
}
.postbox_media_photo_img {
    /* display: block; */
    margin-left: auto;
    margin-right: auto;
    margin-top:auto;
    margin-bottom: auto;
    width: 100%;
}
.btn-reset {
    background: none;
    border: none;
    filter: none;
    padding: 0;
    outline: none;
    cursor: pointer;
}
</style>