<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
const emit = defineEmits(["linkRemoved"])
const props = defineProps({
    src: {type: String, required: true},
})
const imageUrl = ref("")
const caption = ref("")
onMounted(()=>{
    // src file may not be image
    thumbnail()
})
watch(()=>props.src, (newVal, oldVal)=>{
    if (newVal !== oldVal) {
        thumbnail()
    }
})

function thumbnail() {
    // everything else, draw avtar with file extensioin
    const canvas = document.createElement("canvas");
    let ctx = canvas.getContext("2d")!;
    canvas.width = 80;
    canvas.height = 80;
    ctx.font = '48px serif';
    ctx.fillText("cid", 15, 60);
    imageUrl.value = canvas.toDataURL("image/png");
    caption.value = props.src
}
</script>

<template>
    <div class="postbox_media_photo_wrapper" :style="{position: 'relative'}">
        <div style="position: absolute; display: flex; top: -5px; right: -20px;">
            <button @click='emit("linkRemoved")' title="Close" class="btn-reset" type="button">
            <svg style="width:20px; height:20px;">
                <circle cx="10" cy="10" r="10" stroke="black" stroke-width="0" fill="#ee8855" />
                <line x1="5" y1="5" x2="15" y2="15" style="stroke:#fff;stroke-width:2"></line>
                <line x1="15" y1="5" x2="5" y2="15" style="stroke:#fff;stroke-width:2"></line>
            </svg>
            </button>
        </div>
        <img :src="imageUrl" alt="Thumbnail" width="120" height="120" />
        <div style="font-size:smaller; overflow-wrap: break-word;">{{caption}}</div>
    </div>
</template>

<style>
.postbox_media_photo_wrapper {
  position: relative;
  display: inline-block;
  background-color: #fff;
  border-radius: 3px;
  box-shadow: 0 1px 3px rgba(0,0,0,.1);
  transition: All .15s ease-out;
  /* max-width: calc(25% - 32px); */
  flex-grow: 1;
  margin-right: 20px;
  margin-left: 10px;
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