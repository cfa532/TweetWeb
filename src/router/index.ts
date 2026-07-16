import { createRouter, createWebHashHistory, createWebHistory, createMemoryHistory } from 'vue-router';
import type { RouteLocationNormalized } from 'vue-router';
import { UserPage, MainPage, TweetDetail, UserLogin as Login, AddPost, CloudFileList, Shared,
  IPs, UploadPackage, DownloadPackage, DownloadPage, Followings, Followers, Contact, UploadFile,
  MediaViewerModal, UserAccount, LeitherSetupNotice
} from "@/components"
import { useAlertStore } from '@/stores';

const loginModalRouteNames = new Set([
  'main',
  'TweetDetail',
  'UserPage',
  'followings',
  'followers',
  'shared',
  'downloadApk',
  'download',
  'apk',
  'app',
  'install',
  'leitherSetupNotice',
  'contact',
])

function getStoredLoginUser() {
  return sessionStorage.getItem("user")
}

function scrollBehavior(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
  savedPosition: { left: number; top: number } | null
) {
  // Deep link to a specific tweet on a profile: start at top, UserPage scrolls
  // it into view itself.
  if (to.query.scrollTweet) return { left: 0, top: 0 }
  // The keep-alive list pages (main feed, user profile, followers/followings)
  // restore their own scroll synchronously in onActivated (see
  // composables/useScrollRestore). Returning false keeps vue-router from applying
  // a delayed scroll — that delay was the cause of the top-then-position flash on
  // back-navigation and reload. It also supersedes the old scrollTweet-stripping
  // special case (no scroll = no jump).
  if (to.name === 'main' || to.name === 'UserPage' || to.name === 'followers' || to.name === 'followings') return false
  // Back/forward navigation: restore the previous scroll. The list pages are
  // kept alive (<keep-alive>), so their DOM is intact at full height and this
  // restores instantly without any flash.
  if (savedPosition) return savedPosition
  if (to.hash) return { el: to.hash, behavior: 'smooth' as const }
  return { left: 0, top: 0 }
}

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior,
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
    { path: '/account', name: "account", component: UserAccount },
    { path: '/ips', name: "IPs", component: IPs },
    {
      path: '/post/:tweetId?', name: "post", component: AddPost,
      beforeEnter: (to, from, next) => {
        let user = getStoredLoginUser()
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
        let user = getStoredLoginUser()
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
        let user = getStoredLoginUser()
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
        let user = getStoredLoginUser()
        if (!user || JSON.parse(user)["username"]!="admin") {
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
      path: '/leither-setup-notice',
      name: 'leitherSetupNotice',
      component: LeitherSetupNotice,
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

  if (to.name === 'login' && typeof to.query.redirect === 'string') {
    const target = router.resolve(to.query.redirect)
    const targetName = typeof target.name === 'string' ? target.name : ''

    if (loginModalRouteNames.has(targetName)) {
      return {
        path: target.path,
        query: {
          ...target.query,
          login: '1',
          redirect: to.query.redirect,
        },
        hash: target.hash,
        replace: true,
      }
    }
  }
})

router.afterEach((to) => {
  // This will send a page view event to Google Analytics
  window.gtag('config', 'G-JHJH70L32W', {
    page_path: to.fullPath,
  });
});
