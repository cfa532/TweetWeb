<template>
  <div class="page-layout">
    <slot />
  </div>
</template>

<style>
.page-layout {
  width: 100%;
  max-width: 600px;
  margin: 0;
  background-color: aliceblue;
  overflow-x: hidden; /* Prevent horizontal overflow */
  box-sizing: border-box;
}

/* Ensure content doesn't overflow on mobile */
.page-layout * {
  max-width: 100%;
  box-sizing: border-box;
}

.page-layout img {
  max-width: 100%;
  height: auto;
}
</style>