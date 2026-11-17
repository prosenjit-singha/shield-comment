import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type Language = 'en' | 'bn'

interface LanguageState {
  language: Language
  setLanguage: (language: Language) => void
  toggleLanguage: () => void
}

/** Client UI language. Defaults to English; the choice is persisted to localStorage. */
export const useLanguageStore = create<LanguageState>()(
  persist(
    (set) => ({
      language: 'en',
      setLanguage: (language) => set({ language }),
      toggleLanguage: () => set((s) => ({ language: s.language === 'en' ? 'bn' : 'en' })),
    }),
    {
      name: 'shield-client-lang',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ language }) => ({ language }),
    },
  ),
)
