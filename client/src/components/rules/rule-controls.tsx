import { Plus, X } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLanguage } from '@/hooks/use-language'

/** Native radios as a pill group (`fieldset` + `legend` = an accessible group). */
export function ChoiceGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  hint,
}: {
  legend: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  hint?: ReactNode
}) {
  const name = useId()
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="flex w-fit max-w-full flex-wrap gap-1 rounded-full border bg-muted/40 p-1">
        {options.map((option) => (
          <label
            key={option.value}
            className="cursor-pointer rounded-full px-3.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint ? <p className="text-xs text-pretty text-muted-foreground">{hint}</p> : null}
    </fieldset>
  )
}

/**
 * Removable chips + an "Add" form. `onAdd` validates the raw text and returns an error message (or
 * `null` once added); `addable: false` hides the form (removing stays possible).
 */
export function ChipEditor({
  items,
  listLabel,
  inputLabel,
  placeholder,
  empty,
  addable,
  onAdd,
  onRemove,
}: {
  items: string[]
  listLabel: string
  inputLabel: string
  placeholder: string
  empty: string
  addable: boolean
  onAdd: (raw: string) => string | null
  onRemove: (item: string) => void
}) {
  const { content } = useLanguage()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = onAdd(value)
    setError(problem)
    if (!problem) setValue('')
  }

  return (
    <div className="flex flex-col gap-3">
      {items.length > 0 ? (
        <ul aria-label={listLabel} className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li key={item} className="flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-1 pr-1 pl-3 text-sm">
              <span className="min-w-0 break-all">{item}</span>
              <button
                type="button"
                onClick={() => onRemove(item)}
                aria-label={content(`Remove ${item}`, `${item} সরান`)}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
      {addable ? (
        <form className="flex gap-2" onSubmit={submit}>
          <Input
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            aria-label={inputLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder={placeholder}
            className="h-10 px-4"
          />
          <Button type="submit" variant="outline" className="h-10 shrink-0 px-4">
            <Plus aria-hidden />
            {content('Add', 'যোগ করুন')}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
