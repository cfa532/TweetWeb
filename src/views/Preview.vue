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
async function thumbnail() {
    const fileType = props.src.type || '';
    if (fileType.includes("image")) {
        imageUrl.value = URL.createObjectURL(props.src)
        caption.value = props.src.name
    } else if (fileType.includes("video")) {
        // For videos, create a proper thumbnail from the first frame
        try {
            const videoUrl = URL.createObjectURL(props.src);
            const video = document.createElement("video");
            video.preload = "metadata";
            video.muted = true;
            video.playsInline = true;
            video.src = videoUrl;
            
            await new Promise<void>((resolve, reject) => {
                video.onloadedmetadata = () => resolve();
                video.onerror = () => reject(new Error('Failed to load video'));
                
                // Timeout after 5 seconds
                setTimeout(() => reject(new Error('Video loading timeout')), 5000);
            });
            
            // Seek to 1 second or 10% of video duration (whichever is smaller)
            const seekTime = Math.min(1, video.duration * 0.1);
            video.currentTime = seekTime;
            
            await new Promise<void>((resolve) => {
                video.onseeked = () => resolve();
            });
            
            // Create canvas that fills the entire container (120x120)
            const canvas = document.createElement("canvas");
            const containerSize = 120;
            canvas.width = containerSize;
            canvas.height = containerSize;
            
            const ctx = canvas.getContext("2d")!;
            
            // Calculate scaling to fill container while maintaining aspect ratio (like object-fit: cover)
            const videoAspect = video.videoWidth / video.videoHeight;
            const containerAspect = 1; // 120/120 = 1 (square container)
            
            let drawWidth, drawHeight, offsetX, offsetY;
            
            if (videoAspect > containerAspect) {
                // Video is wider than container - fit to height and crop sides
                drawHeight = containerSize;
                drawWidth = drawHeight * videoAspect;
                offsetX = (containerSize - drawWidth) / 2;
                offsetY = 0;
            } else {
                // Video is taller than container - fit to width and crop top/bottom
                drawWidth = containerSize;
                drawHeight = drawWidth / videoAspect;
                offsetX = 0;
                offsetY = (containerSize - drawHeight) / 2;
            }
            
            // Draw video centered and cropped to fill container
            ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
            
            // Add a play icon overlay to indicate it's a video (bottom-right corner)
            const iconSize = Math.min(canvas.width, canvas.height) * 0.20;
            const padding = iconSize * 0.3; // Small padding from edges
            const centerX = canvas.width - iconSize - padding;
            const centerY = canvas.height - iconSize - padding;
            
            // Draw semi-transparent circle
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.beginPath();
            ctx.arc(centerX, centerY, iconSize, 0, Math.PI * 2);
            ctx.fill();
            
            // Draw play triangle
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.beginPath();
            const triangleSize = iconSize * 0.6;
            ctx.moveTo(centerX - triangleSize * 0.3, centerY - triangleSize * 0.5);
            ctx.lineTo(centerX - triangleSize * 0.3, centerY + triangleSize * 0.5);
            ctx.lineTo(centerX + triangleSize * 0.6, centerY);
            ctx.closePath();
            ctx.fill();
            
            imageUrl.value = canvas.toDataURL("image/png");
            caption.value = props.src.name;
            
            // Clean up
            URL.revokeObjectURL(videoUrl);
        } catch (error) {
            console.error('Error creating video thumbnail:', error);
            // Fallback to placeholder icon
            const canvas = document.createElement("canvas");
            let ctx = canvas.getContext("2d")!;
            canvas.width = 120;
            canvas.height = 120;
            ctx.fillStyle = '#333';
            ctx.fillRect(0, 0, 120, 120);
            ctx.fillStyle = '#fff';
            ctx.font = '48px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🎥', 60, 60);
            imageUrl.value = canvas.toDataURL("image/png");
            caption.value = props.src.name;
        }
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
    justify-content: center;
    align-items: center;
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
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
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