import './assets/main.css'
import 'bootstrap/dist/css/bootstrap.min.css';

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { router } from './router'
import App from './App.vue'

// Import the FontAwesome core
import { library } from '@fortawesome/fontawesome-svg-core';

// Import specific icons
import { faPlay, faPause, faCopy } from '@fortawesome/free-solid-svg-icons';

// Import the FontAwesomeIcon component
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';

// Add icons to the library
library.add(faPlay, faPause, faCopy);

const app = createApp(App)

app.component('font-awesome-icon', FontAwesomeIcon);
app.use(createPinia())
app.use(router)
app.mount('#app')
