import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router';
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

// Backward compatibility for external links created before the fragment-form
// share contract. This runs before Vue Router reads the initial location and
// does not change the app's createWebHistory() navigation mode.
function normalizeLegacyExternalShareUrl() {
  if (typeof window === 'undefined' || window.location.hash) return

  const match = window.location.pathname.match(/^\/(tweet|author)(\/.*)$/)
  if (!match) return

  window.history.replaceState(
    window.history.state,
    '',
    `/#${match[1]}${match[2]}${window.location.search}`,
  )
}

normalizeLegacyExternalShareUrl()

// Leither serves TweetWeb through either /entry or a versioned /mm app
// directory and uses the fragment only for the app route. Keep that loader
// path intact when Vue Router exposes the current route in the address bar.
const leitherEntryPrefix = typeof window !== 'undefined' && (
  window.location.pathname === '/entry' ||
  /^\/mm\/[^/]+:[^/]+\/$/.test(window.location.pathname)
)
  ? `${window.location.pathname}${window.location.search}`
  : null
const routerHistory = leitherEntryPrefix
  ? createWebHashHistory(leitherEntryPrefix)
  : createWebHistory()

function externalLocation(route: RouteLocationNormalized) {
  if (leitherEntryPrefix) {
    return `${leitherEntryPrefix}#/${route.fullPath.replace(/^\//, '')}`
  }
  return `/#${route.fullPath.replace(/^\//, '')}`
}

export const router = createRouter({
  history: routerHistory,
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

  // Domain URLs expose every app route inside a hash envelope, while Vue
  // Router continues to navigate internally in history mode.
  if ((to.path === '/' || to.path === '/entry') && to.hash) {
    const hashRoute = to.hash.replace(/^#\/?/, '')
    if (hashRoute) {
      const target = router.resolve(`/${hashRoute}`)
      if (target.matched.length > 0) {
        return {
          path: target.path,
          query: target.query,
          hash: target.hash,
          replace: true,
        }
      }
    }
  }

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
  // Every domain URL exposes the fragment marker directly after the origin.
  const shareLocation = externalLocation(to)
  const browserLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (browserLocation !== shareLocation) {
    window.history.replaceState(window.history.state, '', shareLocation)
  }

  // This will send a page view event to Google Analytics
  window.gtag('config', 'G-JHJH70L32W', {
    page_path: to.fullPath,
  });
});
