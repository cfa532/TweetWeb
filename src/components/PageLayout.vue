<template>
  <div class="page-layout">
    <slot />
  </div>
</template>

<style>
.page-layout {
  width: 100%;
  margin: 0;
  background-color: #1a1a2e;
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

.tweet-list-row .card-header {
  padding: 0 !important;
}

.tweet-list-row .tweet-content-wrapper {
  padding-left: 0 !important;
  padding-right: 0 !important;
}
</style>