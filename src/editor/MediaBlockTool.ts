/**
 * MediaBlock Tool for Editor.js
 * Custom block for embedding media (images, videos) with CID reference
 */

export interface MediaBlockData {
  cid: string
  mediaType: 'image' | 'video' | 'audio'
  fileName?: string
  caption?: string
  aspectRatio?: number
}

export interface MediaBlockConfig {
  getMediaUrl: (cid: string) => string
}

interface MediaBlockConstructorParams {
  data: MediaBlockData
  config: MediaBlockConfig
  api: any
  readOnly: boolean
}

export default class MediaBlockTool {
  private data: MediaBlockData
  private config: MediaBlockConfig
  private api: any
  private readOnly: boolean
  private wrapper: HTMLElement | null = null

  static get toolbox() {
    return {
      title: 'Media',
      icon: '<svg width="17" height="15" viewBox="0 0 336 276"><path d="M291 150V79c0-19-15-34-34-34H79c-19 0-34 15-34 34v42l67-44 81 72 56-29 42 30zm0 52l-43-30-56 30-81-67-66 39v23c0 19 15 34 34 34h178c17 0 31-13 34-29zM79 0h178c44 0 79 35 79 79v118c0 44-35 79-79 79H79c-44 0-79-35-79-79V79C0 35 35 0 79 0z"/></svg>'
    }
  }

  static get isReadOnlySupported() {
    return true
  }

  constructor({ data, config, api, readOnly }: MediaBlockConstructorParams) {
    this.data = {
      cid: data.cid || '',
      mediaType: data.mediaType || 'image',
      fileName: data.fileName || '',
      caption: data.caption || '',
      aspectRatio: data.aspectRatio
    }
    this.config = config || {}
    this.api = api
    this.readOnly = readOnly
  }

  render(): HTMLElement {
    this.wrapper = document.createElement('div')
    this.wrapper.classList.add('media-block')

    if (!this.data.cid) {
      this.wrapper.innerHTML = '<div class="media-block-placeholder">No media selected</div>'
      return this.wrapper
    }

    // Check if this is a pending (not yet uploaded) media
    const isPending = this.data.cid.startsWith('pending:')

    const container = document.createElement('div')
    container.classList.add('media-block-container')

    if (isPending) {
      // Show placeholder for pending media
      const placeholder = document.createElement('div')
      placeholder.classList.add('media-block-pending')
      placeholder.innerHTML = `
        <div class="pending-icon">📎</div>
        <div class="pending-filename">${this.data.fileName || 'Media'}</div>
        <div class="pending-status">Will upload on submit</div>
      `
      container.appendChild(placeholder)
    } else if (this.data.mediaType === 'image') {
      const mediaUrl = this.config.getMediaUrl
        ? this.config.getMediaUrl(this.data.cid)
        : this.data.cid
      const img = document.createElement('img')
      img.src = mediaUrl
      img.alt = this.data.fileName || 'Image'
      img.classList.add('media-block-image')
      if (this.data.aspectRatio) {
        img.style.aspectRatio = String(this.data.aspectRatio)
      }
      container.appendChild(img)
    } else if (this.data.mediaType === 'video') {
      const mediaUrl = this.config.getMediaUrl
        ? this.config.getMediaUrl(this.data.cid)
        : this.data.cid
      const video = document.createElement('video')
      video.src = mediaUrl
      video.controls = true
      video.classList.add('media-block-video')
      if (this.data.aspectRatio) {
        video.style.aspectRatio = String(this.data.aspectRatio)
      }
      container.appendChild(video)
    } else if (this.data.mediaType === 'audio') {
      const mediaUrl = this.config.getMediaUrl
        ? this.config.getMediaUrl(this.data.cid)
        : this.data.cid
      const audio = document.createElement('audio')
      audio.src = mediaUrl
      audio.controls = true
      audio.classList.add('media-block-audio')
      container.appendChild(audio)
    }

    this.wrapper.appendChild(container)

    // Caption
    if (!this.readOnly) {
      const captionInput = document.createElement('input')
      captionInput.type = 'text'
      captionInput.classList.add('media-block-caption')
      captionInput.placeholder = 'Add a caption...'
      captionInput.value = this.data.caption || ''
      captionInput.addEventListener('input', (e) => {
        this.data.caption = (e.target as HTMLInputElement).value
      })
      this.wrapper.appendChild(captionInput)
    } else if (this.data.caption) {
      const captionDiv = document.createElement('div')
      captionDiv.classList.add('media-block-caption-readonly')
      captionDiv.textContent = this.data.caption
      this.wrapper.appendChild(captionDiv)
    }

    return this.wrapper
  }

  save(): MediaBlockData {
    return {
      cid: this.data.cid,
      mediaType: this.data.mediaType,
      fileName: this.data.fileName,
      caption: this.data.caption,
      aspectRatio: this.data.aspectRatio
    }
  }

  validate(savedData: MediaBlockData): boolean {
    return !!savedData.cid
  }

  static get pasteConfig() {
    return {
      tags: ['IMG'],
      patterns: {
        image: /https?:\/\/\S+\.(gif|jpe?g|tiff|png|webp)$/i
      }
    }
  }
}
