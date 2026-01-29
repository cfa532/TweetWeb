<script setup lang="ts">
import { computed } from 'vue'
import type { PropType } from 'vue'
import { MediaView } from '@/views'
import { useTweetStore } from '@/stores'

interface EditorJSBlock {
  type: string
  data: any
}

interface EditorJSData {
  blocks: EditorJSBlock[]
}

const props = defineProps({
  content: { type: String, default: '' },
  contentType: { type: String as PropType<'txt' | 'editorjs' | undefined>, default: undefined },
  tweet: { type: Object as PropType<Tweet>, required: true },
  maxLines: { type: Number, default: 0 }, // 0 = no limit
  maxChars: { type: Number, default: 0 },  // 0 = no limit
  textOnly: { type: Boolean, default: false }  // If true, only show text (no inline media) - for list view
})

const emit = defineEmits<{
  (e: 'clipped', isClipped: boolean): void
}>()

const tweetStore = useTweetStore()

// Linkify URLs in text
function linkify(text: string): string {
  const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig
  return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>')
}

// Parse Editor.js content
function parseEditorJSContent(content: string): EditorJSData | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed && Array.isArray(parsed.blocks)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

// Check if content is Editor.js format
const isEditorJSContent = computed(() => {
  if (props.contentType === 'editorjs') return true
  if (props.contentType === 'txt') return false

  // Auto-detect: try to parse as JSON
  if (props.content) {
    const parsed = parseEditorJSContent(props.content)
    return parsed !== null
  }
  return false
})

// Parsed blocks for Editor.js content
const editorBlocks = computed(() => {
  if (!isEditorJSContent.value || !props.content) return []

  const parsed = parseEditorJSContent(props.content)
  return parsed?.blocks || []
})

// Processed plain text content (for backwards compatibility)
const plainTextContent = computed(() => {
  if (!props.content || isEditorJSContent.value) return ''

  let text = linkify(props.content)
  let isClipped = false

  // Apply clipping if limits are set
  const isChinese = /[\u4e00-\u9fa5]/.test(text)

  if (props.maxChars > 0 && isChinese && text.length > props.maxChars) {
    text = text.substring(0, props.maxChars) + '...'
    isClipped = true
  } else if (props.maxLines > 0 && !isChinese) {
    const lines = text.split('\n')
    if (lines.length > props.maxLines) {
      text = lines.slice(0, props.maxLines).join('\n') + '...'
      isClipped = true
    }
  }

  emit('clipped', isClipped)
  return text
})

// Convert media block data to MimeiFileType for MediaView
function mediaBlockToMimeiFile(data: any): MimeiFileType {
  return {
    mid: data.cid,
    type: data.mediaType || 'image',
    fileName: data.fileName,
    aspectRatio: data.aspectRatio,
    timestamp: Date.now()
  }
}

// Get media URL from CID
function getMediaUrl(cid: string): string {
  const providerIp = props.tweet?.author?.providerIp || props.tweet?.provider
  const baseUrl = providerIp ? `http://${providerIp}` : ''
  return tweetStore.getMediaUrl(cid, baseUrl)
}

// Process header level
function getHeaderTag(level: number): string {
  const validLevels = [1, 2, 3, 4, 5, 6]
  const actualLevel = validLevels.includes(level) ? level : 2
  return `h${actualLevel}`
}
</script>

<template>
  <div class="content-renderer">
    <!-- Editor.js content -->
    <template v-if="isEditorJSContent && editorBlocks.length > 0">
      <template v-for="(block, index) in editorBlocks" :key="index">
        <!-- Paragraph -->
        <p v-if="block.type === 'paragraph'" class="content-paragraph" v-html="linkify(block.data.text || '')"></p>

        <!-- Header -->
        <component
          v-else-if="block.type === 'header'"
          :is="getHeaderTag(block.data.level)"
          class="content-header"
          v-html="linkify(block.data.text || '')"
        ></component>

        <!-- List -->
        <component
          v-else-if="block.type === 'list'"
          :is="block.data.style === 'ordered' ? 'ol' : 'ul'"
          class="content-list"
        >
          <li v-for="(item, itemIndex) in block.data.items" :key="itemIndex" v-html="linkify(item)"></li>
        </component>

        <!-- Media: only show if not textOnly mode -->
        <div v-else-if="block.type === 'media' && !textOnly" class="content-media">
          <MediaView
            :media="mediaBlockToMimeiFile(block.data)"
            :tweet="tweet"
          />
          <p v-if="block.data.caption" class="media-caption">{{ block.data.caption }}</p>
        </div>
      </template>
    </template>

    <!-- Plain text content (backwards compatibility) -->
    <p v-else-if="plainTextContent" class="content-text" v-html="plainTextContent"></p>
  </div>
</template>

<style scoped>
.content-renderer {
  width: 100%;
}

.content-paragraph,
.content-text {
  text-align: left;
  font-size: medium;
  white-space: pre-wrap;
  padding: 4px 0 0 8px;
  margin: 0 0 8px 0;
}

.content-paragraph:last-child,
.content-text:last-child {
  margin-bottom: 0;
}

.content-header {
  padding: 4px 0 0 8px;
  margin: 0 0 8px 0;
}

.content-list {
  padding-left: 24px;
  margin: 0 0 8px 8px;
}

.content-list li {
  margin-bottom: 4px;
}

.content-media {
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
}

.media-caption {
  text-align: center;
  font-size: 14px;
  color: #666;
  margin: 8px 0 0 0;
  padding: 0 8px;
}

/* Link styling */
.content-renderer :deep(a) {
  color: blue;
  text-decoration: underline;
}
</style>
