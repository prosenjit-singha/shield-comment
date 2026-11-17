import { useCallback } from 'react'
import { useLanguageStore } from '@/stores/language-store'

/**
 * Bilingual text helper for the client app (AGENTS.md: all UI text goes through `content`).
 * `content('Hello', 'হ্যালো')` returns the string for the current language.
 */
export function useLanguage() {
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const toggleLanguage = useLanguageStore((s) => s.toggleLanguage)

  const content = useCallback(
    (english: string, bangla: string): string => (language === 'bn' ? bangla : english),
    [language],
  )

  return { language, setLanguage, toggleLanguage, content }
}
