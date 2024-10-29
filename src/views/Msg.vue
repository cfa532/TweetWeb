<script setup lang="ts">
import { ref } from "vue";
const msgBox = ref()

</script>
<template>
    <p ref="msgBox" style="margin-left:0px; width:98%; padding-left: 5px; padding-top: 10px; position:relative; border-top: 0px solid gainsboro; color:gray; word-wrap: break-word;">
        <slot></slot>
    </p>
</template>