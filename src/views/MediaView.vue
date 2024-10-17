<script setup lang="ts">
import { computed } from "vue";
import { Image, PDFView, VideoJS } from './index'

const props = defineProps<{ mid: string, type: string }>();

const userComponent = computed(() => {
    let p = props.type.toLowerCase()
    if (p.includes("image")) {
        return Image
    } else if (p.includes("pdf")) {
        return PDFView
    } else if (p.includes("video") || p.includes("audio") ) {
        return VideoJS
    } else {
        console.warn("Unknown file type:", p)
        return "<p>Unkonwn file type</P>"
    }
})
</script>

<template>
    <div class="container text-left topm">
        <div class="row justify-content-start">
            <!-- Delete page function is in the Share Menu -->
            <div class="col">
                 
                <KeepAlive>
                    <component :is="userComponent" v-bind="props"></component>
                </KeepAlive>
            </div>
        </div>
    </div>
</template>
<style>
.topm {
    margin: 10px 0 0 0px;
}
</style>
