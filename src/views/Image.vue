<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useLeitherStore } from '@/stores/leitherStore';
const api = useLeitherStore();    // Leither api handler

const props = defineProps({
    mid : {type: String, required: false},      // undefined when showing local files
    type: {type: String, required: true},
    title: {type: String, required: false},
    fileName: {type: String, required: false},
    name: {type: String, required: false},
    index: {type: Number, required: false},
    autoplay: {type: Boolean, required: false},
})

onMounted(async () => {
});
</script>

<template>
    <div>
        <img :src="props.mid"/>
    </div>
</template>

<style>
.container {
    /* text-align: left; */
    margin: 0px;
    padding: 0px;
    /* float: left; */
    display: inline-block;
}
.container img {
    /* position:relative; */
    display: block;
    max-width: 100%;
    width: 100%;
    height: auto;
}
.container p {
    /* display: block; */
    text-align: center;
    position: relative;
    margin-top: 5px; 
    margin-bottom: 10px; 
    font-size: small; 
    color:darkslategray; 
}
</style>