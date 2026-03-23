import './assets/main.css'
import 'bootstrap/dist/css/bootstrap.min.css';

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { router } from './router'
import i18n from './i18n'
import App from './App.vue'

// Import the FontAwesome core
import { library } from '@fortawesome/fontawesome-svg-core';

// Import specific icons
import { faPlay, faPause, faCopy, faPen, faTrashCan } from '@fortawesome/free-solid-svg-icons';

// Import the FontAwesomeIcon component
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';

// Add icons to the library
library.add(faPlay, faPause, faCopy, faPen, faTrashCan);

const app = createApp(App)

app.component('font-awesome-icon', FontAwesomeIcon);
app.use(createPinia())
app.use(i18n)
app.use(router)
app.mount('#app')
