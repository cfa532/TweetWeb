import { computed, onBeforeUnmount, onMounted, ref, watch, type InjectionKey, type Ref } from 'vue'
import { isImageType, isVideoType, normalizeMediaType } from '@/lib'

export type MediaLoadState = 'idle' | 'preload' | 'visible'
export const TWEET_MEDIA_PRELOAD_STALE_EVENT = 'tweet-media-preload-stale'
export type TweetMediaElementRegistrar = (tweetId: string, media: MimeiFileType, element: Element | null) => void
export const TWEET_MEDIA_ELEMENT_REGISTRY_KEY: InjectionKey<TweetMediaElementRegistrar> = Symbol('tweet-media-element-registry')

interface TweetEntry {
  tweet: Tweet
  element: HTMLElement
  ratio: number
  top: number
}

interface MediaEntry {
  tweetId: string
  media: MimeiFileType
  element: HTMLElement
  ratio: number
  top: number
  visible: boolean
}

const TWEET_VISIBLE_THRESHOLD = 0.01
const DIRECTIONAL_IMAGE_TWEETS = 2
const DIRECTIONAL_VIDEOS = 2
const REVERSE_TWEETS = 1
const SCROLL_SETTLE_PRELOAD_DELAY_MS = 180
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])

function isImageMedia(media: MimeiFileType): boolean {
  const type = normalizeMediaType(media.type)
  return isImageType(type) || type.includes('image')
}

function isVideoMedia(media: MimeiFileType): boolean {
  const type = normalizeMediaType(media.type)
  return isVideoType(type) || type.includes('video')
}

function mediaItems(tweet: Tweet): MimeiFileType[] {
  return tweet.attachments || []
}

function hasImage(tweet: Tweet): boolean {
  return mediaItems(tweet).some(isImageMedia)
}

function visibilityForElement(element: HTMLElement): { ratio: number; top: number; visible: boolean } {
  if (typeof window === 'undefined') return { ratio: 0, top: 0, visible: false }
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return { ratio: 0, top: rect.top, visible: false }
  const visibleLeft = Math.max(rect.left, 0)
  const visibleRight = Math.min(rect.right, window.innerWidth)
  const visibleTop = Math.max(rect.top, 0)
  const visibleBottom = Math.min(rect.bottom, window.innerHeight)
  const visibleWidth = Math.max(0, visibleRight - visibleLeft)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)
  const visibleArea = visibleWidth * visibleHeight
  return {
    ratio: visibleArea / (rect.width * rect.height),
    top: rect.top,
    visible: visibleArea > 0,
  }
}

function mediaKey(tweetId: string, media: MimeiFileType): string {
  return `${tweetId}\n${media.mid}`
}

function debugMediaPlan(message: string, payload: Record<string, unknown>) {
  if (!import.meta.env.DEV) return
  console.debug(`[MEDIA COORD] ${message}`, payload)
}

export function useTweetMediaLoadingCoordinator(tweets: Ref<Tweet[]>) {
  const entries = new Map<string, TweetEntry>()
  const mediaEntries = new Map<string, MediaEntry>()
  const version = ref(0)
  const scrollDirection = ref<'down' | 'up'>('down')
  const canPreloadIdleMedia = ref(true)
  let observer: IntersectionObserver | null = null
  let lastScrollY = typeof window !== 'undefined' ? window.scrollY : 0
  let scrollFrame: number | null = null
  let scrollSettleTimer: number | null = null
  let lastPlanKey = ''

  function bump() {
    version.value += 1
  }

  function sortedEntries(): TweetEntry[] {
    version.value
    return tweets.value
      .map(tweet => entries.get(tweet.mid))
      .filter((entry): entry is TweetEntry => Boolean(entry))
      .sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  }

  function lastIndexBeforeViewport(entries: TweetEntry[]): number {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].top < 0) return index
    }
    return entries.length - 1
  }

  function visibleMediaKeys(): Set<string> {
    version.value
    const keys = new Set<string>()
    for (const [key, entry] of mediaEntries) {
      if (entry.visible) keys.add(key)
    }
    return keys
  }

  const loadingPlan = computed(() => {
    const ordered = sortedEntries()
    const visibleMediaIds = visibleMediaKeys()
    const visibleTweetIds = new Set<string>()
    const preloadTweetIds = new Set<string>()
    const preloadVideoIds = new Set<string>()

    for (const entry of ordered) {
      if (entry.ratio >= TWEET_VISIBLE_THRESHOLD) {
        visibleTweetIds.add(entry.tweet.mid)
      }
    }

    const visibleIndexes = ordered
      .map((entry, index) => entry.ratio >= TWEET_VISIBLE_THRESHOLD ? index : -1)
      .filter(index => index >= 0)

    if (ordered.length > 0 && canPreloadIdleMedia.value) {
      const direction = scrollDirection.value
      const startIndex = direction === 'down'
        ? (visibleIndexes.length ? Math.max(...visibleIndexes) + 1 : ordered.findIndex(entry => entry.top > 0))
        : (visibleIndexes.length ? Math.min(...visibleIndexes) - 1 : lastIndexBeforeViewport(ordered))

      const directionalIndexes: number[] = []
      if (direction === 'down') {
        for (let i = Math.max(0, startIndex); i < ordered.length; i += 1) {
          directionalIndexes.push(i)
        }
      } else {
        for (let i = Math.min(ordered.length - 1, startIndex); i >= 0; i -= 1) {
          directionalIndexes.push(i)
        }
      }

      let imageTweetCount = 0
      let videoCount = 0
      for (const index of directionalIndexes) {
        const entry = ordered[index]
        if (!entry || visibleTweetIds.has(entry.tweet.mid)) continue

        if (imageTweetCount < DIRECTIONAL_IMAGE_TWEETS && hasImage(entry.tweet)) {
          preloadTweetIds.add(entry.tweet.mid)
          imageTweetCount += 1
        }

        if (videoCount < DIRECTIONAL_VIDEOS) {
          for (const media of mediaItems(entry.tweet)) {
            if (!isVideoMedia(media)) continue
            preloadVideoIds.add(media.mid)
            videoCount += 1
            if (videoCount >= DIRECTIONAL_VIDEOS) break
          }
        }

        if (imageTweetCount >= DIRECTIONAL_IMAGE_TWEETS && videoCount >= DIRECTIONAL_VIDEOS) {
          break
        }
      }

      const reverseStart = direction === 'down'
        ? (visibleIndexes.length ? Math.min(...visibleIndexes) - 1 : startIndex - 1)
        : (visibleIndexes.length ? Math.max(...visibleIndexes) + 1 : startIndex + 1)

      let reverseCount = 0
      if (direction === 'down') {
        for (let i = reverseStart; i >= 0 && reverseCount < REVERSE_TWEETS; i -= 1) {
          const entry = ordered[i]
          if (!entry || visibleTweetIds.has(entry.tweet.mid)) continue
          preloadTweetIds.add(entry.tweet.mid)
          reverseCount += 1
        }
      } else {
        for (let i = reverseStart; i < ordered.length && reverseCount < REVERSE_TWEETS; i += 1) {
          const entry = ordered[i]
          if (!entry || visibleTweetIds.has(entry.tweet.mid)) continue
          preloadTweetIds.add(entry.tweet.mid)
          reverseCount += 1
        }
      }
    }

    return { visibleMediaIds, visibleTweetIds, preloadTweetIds, preloadVideoIds }
  })

  watch(loadingPlan, (plan) => {
    const visibleMedia = [...plan.visibleMediaIds]
    const visible = [...plan.visibleTweetIds]
    const preloadTweets = [...plan.preloadTweetIds]
    const preloadVideos = [...plan.preloadVideoIds]
    const key = [
      scrollDirection.value,
      canPreloadIdleMedia.value ? 'settled' : 'scrolling',
      visibleMedia.join(','),
      visible.join(','),
      preloadTweets.join(','),
      preloadVideos.join(','),
    ].join('|')
    if (key === lastPlanKey) return
    lastPlanKey = key
    debugMediaPlan('plan', {
      direction: scrollDirection.value,
      preloadEnabled: canPreloadIdleMedia.value,
      visibleMedia,
      visibleTweets: visible,
      preloadImageTweets: preloadTweets,
      preloadVideos,
    })
  }, { flush: 'post' })

  function getMediaLoadState(tweetId: string, media: MimeiFileType): MediaLoadState {
    const plan = loadingPlan.value
    if (plan.visibleMediaIds.has(mediaKey(tweetId, media))) return 'visible'
    if (isImageMedia(media) && plan.preloadTweetIds.has(tweetId)) return 'preload'
    if (isVideoMedia(media) && plan.preloadVideoIds.has(media.mid)) return 'preload'
    return 'idle'
  }

  function setTweetElement(tweet: Tweet, element: Element | null) {
    const existing = entries.get(tweet.mid)
    if (existing && existing.element === element) {
      existing.tweet = tweet
      return
    }

    if (existing && existing.element !== element) {
      observer?.unobserve(existing.element)
      entries.delete(tweet.mid)
    }

    if (element instanceof HTMLElement) {
      const initialVisibility = visibilityForElement(element)
      entries.set(tweet.mid, {
        tweet,
        element,
        ratio: initialVisibility.ratio,
        top: initialVisibility.top,
      })
      observer?.observe(element)
    }
    bump()
  }

  function setMediaElement(tweetId: string, media: MimeiFileType, element: Element | null) {
    const key = mediaKey(tweetId, media)
    const existing = mediaEntries.get(key)
    if (existing && existing.element === element) {
      existing.media = media
      return
    }

    if (existing && existing.element !== element) {
      observer?.unobserve(existing.element)
      mediaEntries.delete(key)
    }

    if (element instanceof HTMLElement) {
      const visibility = visibilityForElement(element)
      mediaEntries.set(key, {
        tweetId,
        media,
        element,
        ratio: visibility.ratio,
        top: visibility.top,
        visible: visibility.visible,
      })
      observer?.observe(element)
    }
    bump()
  }

  function updateViewportState() {
    if (scrollFrame != null) return
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = null
      const y = window.scrollY
      if (y !== lastScrollY) {
        scrollDirection.value = y > lastScrollY ? 'down' : 'up'
        lastScrollY = y
      }
      for (const entry of entries.values()) {
        const visibility = visibilityForElement(entry.element)
        entry.ratio = visibility.ratio
        entry.top = visibility.top
      }
      for (const entry of mediaEntries.values()) {
        const visibility = visibilityForElement(entry.element)
        entry.ratio = visibility.ratio
        entry.top = visibility.top
        entry.visible = visibility.visible
      }
      bump()
    })
  }

  function markScrollActive() {
    if (canPreloadIdleMedia.value) {
      canPreloadIdleMedia.value = false
      window.dispatchEvent(new CustomEvent(TWEET_MEDIA_PRELOAD_STALE_EVENT))
    }
    if (scrollSettleTimer != null) {
      window.clearTimeout(scrollSettleTimer)
    }
    scrollSettleTimer = window.setTimeout(() => {
      scrollSettleTimer = null
      canPreloadIdleMedia.value = true
      updateViewportState()
    }, SCROLL_SETTLE_PRELOAD_DELAY_MS)
  }

  function handleScrollIntent(event?: Event) {
    if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) return
    markScrollActive()
    updateViewportState()
  }

  function handleScroll() {
    markScrollActive()
    updateViewportState()
  }

  onMounted(() => {
    observer = new IntersectionObserver((observedEntries) => {
      for (const observed of observedEntries) {
        let matched = false
        for (const entry of entries.values()) {
          if (entry.element !== observed.target) continue
          entry.ratio = observed.intersectionRatio
          entry.top = observed.boundingClientRect.top
          matched = true
          break
        }
        if (matched) continue
        for (const entry of mediaEntries.values()) {
          if (entry.element !== observed.target) continue
          const visibility = visibilityForElement(entry.element)
          entry.ratio = visibility.ratio
          entry.top = visibility.top
          entry.visible = visibility.visible
          break
        }
      }
      bump()
    }, { threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] })

    for (const entry of entries.values()) {
      observer.observe(entry.element)
    }
    for (const entry of mediaEntries.values()) {
      observer.observe(entry.element)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll, { passive: true })
    window.addEventListener('wheel', handleScrollIntent, { passive: true, capture: true })
    window.addEventListener('touchmove', handleScrollIntent, { passive: true, capture: true })
    window.addEventListener('keydown', handleScrollIntent, { capture: true })
    updateViewportState()
  })

  onBeforeUnmount(() => {
    if (scrollFrame != null) {
      window.cancelAnimationFrame(scrollFrame)
      scrollFrame = null
    }
    if (scrollSettleTimer != null) {
      window.clearTimeout(scrollSettleTimer)
      scrollSettleTimer = null
    }
    window.removeEventListener('scroll', handleScroll)
    window.removeEventListener('resize', handleScroll)
    window.removeEventListener('wheel', handleScrollIntent, { capture: true })
    window.removeEventListener('touchmove', handleScrollIntent, { capture: true })
    window.removeEventListener('keydown', handleScrollIntent, { capture: true })
    observer?.disconnect()
    observer = null
    entries.clear()
    mediaEntries.clear()
  })

  return {
    setTweetElement,
    setMediaElement,
    getMediaLoadState,
  }
}
