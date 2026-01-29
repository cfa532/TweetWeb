<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import EditorJS from '@editorjs/editorjs'
import type { OutputData } from '@editorjs/editorjs'
import Header from '@editorjs/header'
import List from '@editorjs/list'
import Paragraph from '@editorjs/paragraph'
import MediaBlockTool from '@/editor/MediaBlockTool'
import type { MediaBlockData } from '@/editor/MediaBlockTool'

interface Props {
  modelValue?: string
  placeholder?: string
  getMediaUrl?: (cid: string) => string
  readOnly?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: 'Start writing...',
  readOnly: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'ready'): void
}>()

const editorContainer = ref<HTMLElement | null>(null)
let editor: EditorJS | null = null

// Default media URL function if not provided
const defaultGetMediaUrl = (cid: string) => cid

onMounted(async () => {
  if (!editorContainer.value) return

  // Parse initial content if it exists
  let initialData: OutputData | undefined
  if (props.modelValue) {
    try {
      initialData = JSON.parse(props.modelValue)
    } catch {
      // If not valid JSON, treat as plain text and convert to paragraph block
      initialData = {
        blocks: [
          {
            type: 'paragraph',
            data: { text: props.modelValue }
          }
        ]
      }
    }
  }

  editor = new EditorJS({
    holder: editorContainer.value,
    placeholder: props.placeholder,
    readOnly: props.readOnly,
    data: initialData,
    tools: {
      header: {
        class: Header as any,
        config: {
          levels: [1, 2, 3],
          defaultLevel: 2
        }
      },
      list: {
        class: List as any,
        inlineToolbar: true
      },
      paragraph: {
        class: Paragraph as any,
        inlineToolbar: true
      },
      media: {
        class: MediaBlockTool as any,
        config: {
          getMediaUrl: props.getMediaUrl || defaultGetMediaUrl
        }
      }
    },
    // Removed onChange to prevent recomposition during typing
    // Content is retrieved via getContent() when needed
    onReady: () => {
      emit('ready')
    }
  })
})

onBeforeUnmount(() => {
  if (editor) {
    editor.destroy()
    editor = null
  }
})

// Watch for external modelValue changes
watch(() => props.modelValue, async (newValue) => {
  if (!editor || !newValue) return

  try {
    const currentData = await editor.save()
    const newData = JSON.parse(newValue)

    // Only update if data is different (avoid infinite loops)
    if (JSON.stringify(currentData) !== JSON.stringify(newData)) {
      await editor.render(newData)
    }
  } catch {
    // Ignore parse errors
  }
})

// Expose methods for parent component
async function getContent(): Promise<string> {
  if (!editor) return ''
  const data = await editor.save()
  return JSON.stringify(data)
}

async function insertMedia(mediaData: MediaBlockData): Promise<void> {
  if (!editor) return

  await editor.blocks.insert('media', mediaData)
}

async function insertMediaAtIndex(mediaData: MediaBlockData, index?: number): Promise<void> {
  if (!editor) return

  const currentIndex = index ?? editor.blocks.getCurrentBlockIndex()
  await editor.blocks.insert('media', mediaData, undefined, currentIndex + 1)
}

async function clear(): Promise<void> {
  if (!editor) return
  await editor.clear()
}

async function focus(): Promise<void> {
  if (!editor) return
  editor.focus()
}

function isEmpty(): boolean {
  if (!editor) return true
  return editor.blocks.getBlocksCount() === 0
}

defineExpose({
  getContent,
  insertMedia,
  insertMediaAtIndex,
  clear,
  focus,
  isEmpty
})
</script>

<template>
  <div class="block-editor-wrapper">
    <div ref="editorContainer" class="block-editor"></div>
  </div>
</template>

<style scoped>
.block-editor-wrapper {
  width: 100%;
  min-height: 200px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background-color: #fff;
}

.block-editor {
  padding: 10px;
}

/* Editor.js block styles */
.block-editor :deep(.ce-block__content) {
  max-width: 100%;
}

.block-editor :deep(.ce-toolbar__content) {
  max-width: 100%;
}

.block-editor :deep(.ce-paragraph) {
  line-height: 1.6;
}

/* Media block styles */
.block-editor :deep(.media-block) {
  margin: 10px 0;
  padding: 10px;
  border-radius: 8px;
  background-color: #f9f9f9;
}

.block-editor :deep(.media-block-container) {
  display: flex;
  justify-content: center;
  overflow: hidden;
  border-radius: 4px;
}

.block-editor :deep(.media-block-image) {
  max-width: 100%;
  max-height: 400px;
  object-fit: contain;
  border-radius: 4px;
}

.block-editor :deep(.media-block-video) {
  max-width: 100%;
  max-height: 400px;
  border-radius: 4px;
}

.block-editor :deep(.media-block-audio) {
  width: 100%;
}

.block-editor :deep(.media-block-caption) {
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  text-align: center;
}

.block-editor :deep(.media-block-caption:focus) {
  outline: none;
  border-color: #007bff;
}

.block-editor :deep(.media-block-caption-readonly) {
  margin-top: 8px;
  padding: 8px;
  font-size: 14px;
  text-align: center;
  color: #666;
}

.block-editor :deep(.media-block-placeholder) {
  padding: 20px;
  text-align: center;
  color: #999;
  background-color: #f0f0f0;
  border-radius: 4px;
}

.block-editor :deep(.media-block-pending) {
  padding: 20px;
  text-align: center;
  background-color: #fff3cd;
  border: 2px dashed #ffc107;
  border-radius: 8px;
}

.block-editor :deep(.media-block-pending .pending-icon) {
  font-size: 32px;
  margin-bottom: 8px;
}

.block-editor :deep(.media-block-pending .pending-filename) {
  font-weight: 600;
  color: #333;
  margin-bottom: 4px;
  word-break: break-all;
}

.block-editor :deep(.media-block-pending .pending-status) {
  font-size: 12px;
  color: #856404;
}
</style>
