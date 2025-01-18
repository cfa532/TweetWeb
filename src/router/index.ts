import { createRouter, createWebHashHistory, createWebHistory, createMemoryHistory } from 'vue-router';
import { UserPage, MainPage, TweetDetail, UserLogin as Login, AddPost, IPs, UploadPackage, DownloadPackage, Followings, Followers } from "@/components"
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
      path: '/tweet/:tweetId/:authorId?',
      name: 'TweetDetail',
      component: TweetDetail,
      props: false,
    },
    {
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
      path: '/post', name: "post", component: AddPost,
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("user")
        if (!user) {
          next("login")
        } else
          next()
      },
    },
    { path: '/upload',
      name: "upload",
      component: UploadPackage,
      beforeEnter: (to: any, from: any, next: any) => {
        let user = sessionStorage.getItem("user")
        if (!user || JSON.parse(user)["username"]!="developer") {
          next("login")
        } else
          next()
      },
    },
    {
      path: '/download',
      name: "download",
      component: DownloadPackage,
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