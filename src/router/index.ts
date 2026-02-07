import { createRouter, createWebHashHistory, createWebHistory, createMemoryHistory } from 'vue-router';
import { UserPage, MainPage, TweetDetail, UserLogin as Login, AddPost, CloudFileList, Shared,
  IPs, UploadPackage, DownloadPackage, DownloadPage, Followings, Followers, Contact, UploadFile,
  MediaViewerModal
} from "@/components"
import { useAlertStore } from '@/stores';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { 
      path: '/', name: "main", component: MainPage
    },
    {
      // display tweets on main screen
      path: '/tweet/:tweetId/:authorId?',
      name: 'TweetDetail',
      component: TweetDetail,
      props: false,
    },
    {
      // display user tweets
      path: '/author/:authorId',
      name: 'UserPage',
      component: UserPage,
      props: false,
    },
    { path: '/followings/:userId', name: "followings", component: Followings },
    { path: '/followers/:userId', name: "followers", component: Followers },
    { 
      path: '/login', 
      name: "login", 
      component: Login,
      props: (route) => ({ redirect: route.query.redirect || '/' })
    },
    { path: '/ips', name: "IPs", component: IPs },
    {
      path: '/post/:tweetId?', name: "post", component: AddPost,
      beforeEnter: (to, from, next) => {
        let user = sessionStorage.getItem("user")
        if (!user) {
          next({ name: 'login', query: { redirect: to.fullPath } })
        } else
          next()
      }
    },
    {
      path: '/shared/:mid',
      name: "shared",
      component: Shared,
      props: true
    },
    {
      // show files on appointed location on a server
      path: '/netdisk',
      name: 'netdisk',
      component: CloudFileList,
      beforeEnter: (to, from, next) => {
        let user = sessionStorage.getItem("user")
        if (!user) {
          next({ name: 'login', query: { redirect: to.fullPath } })
        } else
          next()
      },
    },
    {
      // upload regular file to server
      path: '/upload',
      name: "uploadFile",
      component: UploadFile,
      beforeEnter: (to, from, next) => {
        let user = sessionStorage.getItem("user")
        if (!user) {
          next({ name: 'login', query: { redirect: to.fullPath } })
        } else {
          next()
        }
      }
    },
    { 
      // publish installation package as Mimei
      path: '/uploadApk',
      name: "uploadApk",
      component: UploadPackage,
      beforeEnter: (to, from, next) => {
        let user = sessionStorage.getItem("user")
        if (!user || JSON.parse(user)["username"]!="developer") {
          next({ name: 'login', query: { redirect: to.fullPath } })
        } else
          next()
      },
    },
    {
      path: '/downloadApk',
      name: "downloadApk",
      component: DownloadPackage,
    },
    {
      path: '/download',
      name: "download",
      component: DownloadPage,
    },
    {
      path: '/apk',
      name: "apk",
      component: DownloadPage,
    },
    {
      path: '/app',
      name: "app",
      component: DownloadPage,
    },
    {
      path: '/install',
      name: "install",
      component: DownloadPage,
    },
    {
      // for user sending message to App contact.
      path: '/contact',
      name: "contact",
      component: Contact,
    },
    {
      // Media viewer modal for full-screen image/video viewing
      path: '/media-viewer',
      name: "mediaViewer",
      component: MediaViewerModal,
    },
  ],
})

router.beforeEach((to, from) => {
  useAlertStore().clear()
})

router.afterEach((to) => {
  // This will send a page view event to Google Analytics
  window.gtag('config', 'G-JHJH70L32W', {
    page_path: to.fullPath,
  });
});
