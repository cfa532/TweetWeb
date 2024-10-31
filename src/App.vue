<script setup lang="ts">
import { Alert } from './views';
</script>

<template>
  <div class="container-fluid">
    <Alert/>
    <div class="row justify-content-start align-items-start">
      <div class="col-sm-12 col-md-10 col-lg-6">
        <router-view />
      </div>
    </div>
  </div>
</template>

<style scoped>
.container-fluid {
    padding: 2px 0px 0px 0px;
}
</style>