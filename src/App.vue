<script setup lang="ts">
import { Alert } from './views';
</script>

<template>
  <div class="container-fluid">
    <Alert/>
    <router-view />
    <div class="row justify-content-start align-items-start">
      <div class="col-sm-12 col-md-10 col-lg-8" style="background-color:aliceblue;">
      </div>
    </div>
  </div>
</template>

<style scoped>
.container-fluid {
    padding: 0px;
}
</style>