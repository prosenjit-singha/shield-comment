import { type KeyboardEvent, useRef } from 'react'

export interface PillOption<T extends string> {
  value: T
  label: string
  /** Shown under the label (e.g. the price). */
  hint?: string
  disabled?: boolean
  /** Tooltip, e.g. why the option is disabled. */
  title?: string
}

/**
 * `rounded-full` radio pills (radio group: roving focus, arrow keys move and select, disabled
 * options are skipped). Same look as the plan editor's trial-length picker.
 */
export function PillRadioGroup<T extends string>({
  labelledBy,
  options,
  value,
  onChange,
}: {
  labelledBy: string
  options: PillOption<T>[]
  value: T | undefined
  onChange: (value: T) => void
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]))
  const checkedIndex = options.findIndex((option) => option.value === value && !option.disabled)
  const focusIndex = checkedIndex >= 0 ? checkedIndex : (enabled[0] ?? -1)

  const onKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0 || enabled.length === 0) return
    event.preventDefault()
    const at = Math.max(0, enabled.indexOf(focusIndex))
    const next = enabled[(at + step + enabled.length) % enabled.length] as number
    onChange((options[next] as PillOption<T>).value)
    refs.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="flex flex-wrap gap-2">
      {options.map((option, index) => {
        const checked = index === checkedIndex
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            title={option.title}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`flex min-h-8 flex-col items-center justify-center rounded-full border px-3.5 py-1 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
              checked ? 'border-primary bg-primary/10 font-medium text-primary' : 'enabled:hover:bg-muted'
            }`}
          >
            <span>{option.label}</span>
            {option.hint && (
              <span className={`text-xs tabular-nums ${checked ? 'text-primary/80' : 'text-muted-foreground'}`}>
                {option.hint}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
