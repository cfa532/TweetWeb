<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { MsgVue } from "@/views";

const ips = ref([]);
const aid = ref();
onMounted(()=>{
    if (window.getParam) {
        let p=window.getParam()
        aid.value = p.aid ? p.aid : p.mid
        ips.value = p.ips
        // msg.value = "Resource data provided by:" + p["ips"][p.CurNode] + " from Providers: " + p.ips
    }
})
</script>

<template>
    <MsgVue>
        {{ aid }}
        <a v-for="ip in ips" :href="'http://'+ip+'/entry?mid='+aid+'&ver=last&r=0.'+Date.now()"
          style="color:lightgray" :key="ip">{{ ip }}&comma;&nbsp;</a>
    </MsgVue>
</template>