import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '@/hooks/use-language'
import { addAttachments } from '@/lib/support-tickets'

interface PickedImage {
  file: File
  url: string
}

/** Images picked for the next message, with preview object URLs (revoked on remove, clear and unmount). */
export function usePickedImages() {
  const { content } = useLanguage()
  const [images, setImages] = useState<PickedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(images)
  useEffect(() => {
    latest.current = images
  }, [images])
  useEffect(() => () => latest.current.forEach((image) => URL.revokeObjectURL(image.url)), [])

  return {
    images,
    files: images.map((image) => image.file),
    error,
    add(picked: File[]) {
      const kept = images.map((image) => image.file)
      const result = addAttachments(kept, picked, content)
      setImages([...images, ...result.files.slice(kept.length).map((file) => ({ file, url: URL.createObjectURL(file) }))])
      setError(result.error)
    },
    remove(url: string) {
      URL.revokeObjectURL(url)
      setImages(images.filter((image) => image.url !== url))
      setError(null)
    },
    clear() {
      images.forEach((image) => URL.revokeObjectURL(image.url))
      setImages([])
      setError(null)
    },
  }
}
