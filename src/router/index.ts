import { createRouter, createWebHashHistory, createWebHistory, createMemoryHistory } from 'vue-router';
import { UserPage, MainPage, TweetDetail, UserLogin as Login, AddPost, FileList, Shared,
  IPs, UploadPackage, DownloadPackage, Followings, Followers, Contact, UploadFile
} from "@/components"
import { useAlertStore } from '@/stores';

/**
 * createWebHashHistory: access tweet by IP is ok, by domain not.
 * createWebHistory works for domain base url, so is createWebHistory
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: "main", component: MainPage },
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
    { path: '/login', name: "login", component: Login },
    { path: '/ips', name: "IPs", component: IPs },
    {
      path: '/post/:tweetId?', name: "post", component: AddPost,
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("user")
        if (!user) {
          next("/login")
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
      component: FileList,
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("user")
        if (!user) {
          next("/login")
        } else
          next()
      },
    },
    {
      // upload regular file to server
      path: '/upload',
      name: "uploadFile",
      component: UploadFile,
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("user")
        if (!user || JSON.parse(user)["username"]!="developer") {
          next("/login")
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
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("user")
        if (!user || JSON.parse(user)["username"]!="developer") {
          next("/login")
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
      // for user sending message to App contact.
      path: '/contact',
      name: "contact",
      component: Contact,
    },
  ],
})

router.beforeEach((to: any, from: any) => {
  useAlertStore().clear()
})

router.afterEach((to) => {
  // This will send a page view event to Google Analytics
  window.gtag('config', 'G-JHJH70L32W', {
    page_path: to.fullPath,
  });
});