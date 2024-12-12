<script setup lang="ts">
import { Alert } from './views';
</script>

<template>
  <div class="container-fluid">
    <Alert/>
    <div class="row justify-content-start align-items-start">
      <div class="col-sm-12 col-md-8 col-lg-6" style="background-color:aliceblue;">
        <router-view />
      </div>
    </div>
  </div>
</template>

<style scoped>
.container-fluid {
    padding: 0px;
}
</style>