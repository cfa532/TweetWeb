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
import { faPlay, faPause, faCopy, faPen, faTrashCan, faHeart as fasHeart, faBookmark as fasBookmark, faRetweet, faShareFromSquare, faComment as fasComment, faCircleXmark } from '@fortawesome/free-solid-svg-icons';
import { faHeart as farHeart, faBookmark as farBookmark, faComment as farComment } from '@fortawesome/free-regular-svg-icons';

// Import the FontAwesomeIcon component
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';

// Add icons to the library
library.add(faPlay, faPause, faCopy, faPen, faTrashCan, fasHeart, fasBookmark, faRetweet, faShareFromSquare, fasComment, faCircleXmark);
// Regular icons (outline variants) - cast needed due to fontawesome-common-types version mismatch
[farHeart, farBookmark, farComment].forEach(icon => library.add(icon as any));

const app = createApp(App)

app.component('font-awesome-icon', FontAwesomeIcon);
app.use(createPinia())
app.use(i18n)
app.use(router)
app.mount('#app')
