import { createContext, useContext, useSyncExternalStore } from 'react'
import { createStore, type StoreApi } from 'zustand'
import { writeLanguageCookie, type Language } from '@/lib/language'

export type { Language } from '@/lib/language'

export interface LanguageState {
  language: Language
  setLanguage: (language: Language) => void
  toggleLanguage: () => void
}

export type LanguageStore = StoreApi<LanguageState>

/**
 * Client UI language. One store per router (= per SSR request), never a module singleton, so
 * concurrent server renders can't leak languages into each other. The choice is persisted to the
 * `shield-lang` cookie (not localStorage) so the next server render uses it too.
 */
export function createLanguageStore(initial: Language = 'en'): LanguageStore {
  return createStore<LanguageState>()((set, get) => ({
    language: initial,
    setLanguage: (language) => {
      set({ language })
      writeLanguageCookie(language)
    },
    toggleLanguage: () => get().setLanguage(get().language === 'en' ? 'bn' : 'en'),
  }))
}

export const LanguageStoreContext = createContext<LanguageStore | null>(null)

/**
 * Like zustand's `useStore`, but the server snapshot is the *current* state. zustand uses the initial
 * state there, which would render English even after __root.tsx beforeLoad picked Bangla.
 * Selectors must return stable values (primitives or the store's own functions).
 */
export function useLanguageStoreState<T>(store: LanguageStore, selector: (state: LanguageState) => T): T {
  const read = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, read, read)
}

export function useLanguageStore<T>(selector: (state: LanguageState) => T): T {
  const store = useContext(LanguageStoreContext)
  if (!store) throw new Error('useLanguageStore needs <LanguageStoreContext> (set up in __root.tsx)')
  return useLanguageStoreState(store, selector)
}
