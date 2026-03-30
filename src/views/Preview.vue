<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
const emit = defineEmits(["fileCanceled", "dragStart", "dragOver", "dragLeave", "drop", "dragEnd"])
const props = defineProps({
    src: {type: File, required: true},
    progress: {type: Number, required: false, default:100},     // uploading progress bar
    dragged: {type: Boolean, required: false, default: false},  // whether this item is being dragged
    dragOver: {type: Boolean, required: false, default: false}, // whether this item is being dragged over
})
const imageUrl = ref("")
const caption = ref("")
const activeObjectUrl = ref<string | null>(null)

function revokeActiveObjectUrl() {
    if (activeObjectUrl.value) {
        URL.revokeObjectURL(activeObjectUrl.value)
        activeObjectUrl.value = null
    }
}

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
onUnmounted(() => {
    revokeActiveObjectUrl()
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
    revokeActiveObjectUrl()
    const fileType = props.src.type || '';
    if (fileType.includes("image")) {
        const objectUrl = URL.createObjectURL(props.src)
        activeObjectUrl.value = objectUrl
        imageUrl.value = objectUrl
        caption.value = props.src.name
    } else if (fileType.includes("video")) {
        try {
            imageUrl.value = await createVideoThumbnail(props.src)
        } catch (error) {
            console.warn("Failed to generate video thumbnail, using placeholder:", error)
            imageUrl.value = createVideoPlaceholder()
        }
        caption.value = props.src.name;
    } else {
        // everything else, draw avatar with file extension
        const canvas = document.createElement("canvas");
        let ctx = canvas.getContext("2d")!;
        canvas.width = 120;
        canvas.height = 130;
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(0, 0, 120, 130);
        ctx.fillStyle = '#333';
        ctx.font = '32px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(props.src.name.substring(props.src.name.lastIndexOf('.')+1), 60, 65);
        imageUrl.value = canvas.toDataURL("image/png");
        caption.value = props.src.name
    }
}

function drawVideoFrameToCanvas(video: HTMLVideoElement): string {
    if (!video.videoWidth || !video.videoHeight) {
        throw new Error("Video metadata is unavailable")
    }

    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")
    if (!ctx) {
        throw new Error("Failed to create canvas context")
    }

    canvas.width = 120
    canvas.height = 130

    // Draw with a "cover" strategy so thumbnail layout matches preview box.
    const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
    const drawWidth = video.videoWidth * scale
    const drawHeight = video.videoHeight * scale
    const offsetX = (canvas.width - drawWidth) / 2
    const offsetY = (canvas.height - drawHeight) / 2

    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight)
    return canvas.toDataURL("image/png")
}

function createVideoThumbnail(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file)
        const video = document.createElement("video")
        let settled = false

        const finalize = (result?: string, error?: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timeoutId)
            video.removeEventListener("loadedmetadata", onLoadedMetadata)
            video.removeEventListener("loadeddata", onLoadedData)
            video.removeEventListener("seeked", onSeeked)
            video.removeEventListener("error", onError)
            video.pause()
            video.removeAttribute("src")
            video.load()
            URL.revokeObjectURL(objectUrl)

            if (error) {
                reject(error)
                return
            }
            resolve(result as string)
        }

        const capture = () => {
            try {
                const dataUrl = drawVideoFrameToCanvas(video)
                finalize(dataUrl)
            } catch (error) {
                finalize(undefined, error)
            }
        }

        const onLoadedMetadata = () => {
            if (!Number.isFinite(video.duration) || video.duration <= 0.15) {
                capture()
                return
            }
            const targetTime = Math.min(Math.max(video.duration * 0.1, 0.1), video.duration - 0.05)
            try {
                video.currentTime = targetTime
            } catch {
                capture()
            }
        }

        const onLoadedData = () => {
            // Some browsers never fire seeked for tiny clips; ensure we can still capture.
            if (!Number.isFinite(video.duration) || video.duration <= 0.15) {
                capture()
            }
        }

        const onSeeked = () => {
            capture()
        }

        const onError = () => {
            finalize(undefined, new Error("Video failed to load"))
        }

        const timeoutId = window.setTimeout(() => {
            finalize(undefined, new Error("Video thumbnail generation timed out"))
        }, 5000)

        video.preload = "metadata"
        video.muted = true
        video.playsInline = true
        video.src = objectUrl
        video.addEventListener("loadedmetadata", onLoadedMetadata)
        video.addEventListener("loadeddata", onLoadedData)
        video.addEventListener("seeked", onSeeked)
        video.addEventListener("error", onError)
    })
}

function createVideoPlaceholder(): string {
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")
    if (!ctx) return ""

    canvas.width = 120
    canvas.height = 130
    ctx.fillStyle = "#111"
    ctx.fillRect(0, 0, 120, 130)
    ctx.fillStyle = "#fff"
    ctx.font = "bold 18px sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("VIDEO", 60, 60)
    return canvas.toDataURL("image/png")
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
        <div style="overflow:hidden; height:40px; position:absolute; bottom: 0px; left: 0px; right: 0px; padding: 5px 3px 0px 3px; background: rgba(255, 255, 255, 0.95);">
            <div style="font-size:small; overflow-wrap: break-word;">{{caption}}</div>
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
    top: 0;
    left: 0;
    position: absolute;
    width: 100%;
    height: 130px;
    cursor: move;
    user-select: none;
    overflow: hidden;
    background-color: #000;
}

.postbox_media_photo_wrapper {
    height: 170px;
    width: 120px;
    position: relative;
    display: inline-block;
    background-color: #f5f5f5;
    border-radius: 3px;
    box-shadow: 0 1px 3px rgba(0,0,0,.1);
    transition: All .15s ease-out;
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
    display: block;
    background-color: #000;
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