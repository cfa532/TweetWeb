<script setup lang="ts">
import { Alert } from './views';
</script>

<template>
  <div class="container-fluid">
    <Alert/>
    <router-view />
  </div>
</template>

<style scoped>
.container-fluid {
    padding: 0px;
}
</style>