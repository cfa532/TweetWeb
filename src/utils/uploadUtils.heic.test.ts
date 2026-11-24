import { afterEach, describe, expect, it, vi } from 'vitest'
import { convertHeicToJpeg, isHeicFile } from './uploadUtils'

describe('HEIC uploads', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete (window as any).HeicTo
    })

    it('recognises HEIC by type, or by extension when the browser gives none', () => {
        expect(isHeicFile(new File(['x'], 'IMG_1.HEIC', { type: '' }))).toBe(true)
        expect(isHeicFile(new File(['x'], 'photo', { type: 'image/heif' }))).toBe(true)
        expect(isHeicFile(new File(['x'], 'burst', { type: 'image/heic-sequence' }))).toBe(true)
        expect(isHeicFile(new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' }))).toBe(false)
    })

    it('uses the decoder when the browser cannot read HEIC, and posts a JPEG', async () => {
        // jsdom, like Chrome, fails to load a HEIC image.
        vi.spyOn(window, 'Image').mockImplementation(function (this: any) {
            setTimeout(() => this.onerror?.(), 0)
            return this
        } as any)
        URL.createObjectURL = vi.fn(() => 'blob:heic')
        const heicTo = vi.fn(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }))
        // The decoder script defines window.HeicTo when it loads.
        const append = vi.spyOn(document.head, 'appendChild').mockImplementation((node: any) => {
            expect(node.src).toMatch(/heic-to\.js$/)
            ;(window as any).HeicTo = heicTo
            setTimeout(() => node.onload(), 0)
            return node
        })

        const original = new File(['heic-bytes'], 'IMG_0001.HEIC', { type: 'image/heic', lastModified: 1234 })
        const converted = await convertHeicToJpeg(original)

        expect(append).toHaveBeenCalledTimes(1)
        expect(heicTo).toHaveBeenCalledWith({ blob: original, type: 'image/jpeg', quality: 0.8 })
        expect(converted.name).toBe('IMG_0001.jpg')
        expect(converted.type).toBe('image/jpeg')
        expect(converted.lastModified).toBe(1234)
    })
})
