import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

const SEARCH_DEBOUNCE_MS = 300

/**
 * Debounced search box for list screens. The URL is the source of truth; the box only holds what
 * is being typed. `lastSent` tells our own URL updates apart from outside ones (back button,
 * Clear filters). `onSearch` gets the trimmed text (`''` = no search).
 */
export function SearchInput({
  value,
  onSearch,
  label,
  placeholder,
  maxLength = 100,
  className = 'relative min-w-0 flex-1',
}: {
  value: string
  onSearch: (q: string) => void
  label: string
  placeholder: string
  maxLength?: number
  className?: string
}) {
  const [text, setText] = useState(value)
  const lastSent = useRef(value)
  const onSearchRef = useRef(onSearch)
  useEffect(() => {
    onSearchRef.current = onSearch
  })

  useEffect(() => {
    if (value === lastSent.current) return
    lastSent.current = value
    setText(value)
  }, [value])

  useEffect(() => {
    const q = text.trim()
    if (q === lastSent.current) return
    const timer = setTimeout(() => {
      lastSent.current = q
      onSearchRef.current(q)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text])

  return (
    <div className={className}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        className="h-9 pl-9"
        value={text}
        maxLength={maxLength}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  )
}
