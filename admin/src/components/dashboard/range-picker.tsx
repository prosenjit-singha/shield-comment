import { CalendarRange } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  addDays,
  customRangeError,
  DASHBOARD_PRESETS,
  type DashboardPreset,
  type DashboardSearch,
  dhakaToday,
  MIN_DASHBOARD_DATE,
  presetSearch,
  selectedRange,
} from '@/lib/admin-dashboard'

const presetLabels: Record<DashboardPreset, { short: string; long: string }> = {
  '7d': { short: '7D', long: 'Last 7 days' },
  '30d': { short: '30D', long: 'Last 30 days' },
  '90d': { short: '90D', long: 'Last 90 days' },
  '12m': { short: '12M', long: 'Last 12 months' },
}

/**
 * Preset pills + a custom from/to. The URL is the source of truth; choosing Custom only opens the
 * date form, and Apply navigates once the range passes the same checks as the API.
 */
export function RangePicker({
  search,
  shown,
  onChange,
}: {
  search: DashboardSearch
  /** The range on screen (from the last response); seeds the custom drafts. */
  shown?: { from: string; to: string }
  onChange: (search: DashboardSearch) => void
}) {
  const selected = selectedRange(search)
  const [customOpen, setCustomOpen] = useState(false)
  const tab = selected === 'custom' || customOpen ? 'custom' : selected

  return (
    <div className="flex flex-col gap-3 sm:items-end">
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === 'custom') {
            setCustomOpen(true)
            return
          }
          setCustomOpen(false)
          onChange(presetSearch(value as DashboardPreset))
        }}
      >
        <TabsList aria-label="Date range" className="rounded-full">
          {DASHBOARD_PRESETS.map((preset) => (
            <TabsTrigger
              key={preset}
              value={preset}
              aria-label={presetLabels[preset].long}
              title={presetLabels[preset].long}
              className="rounded-full px-3"
            >
              {presetLabels[preset].short}
            </TabsTrigger>
          ))}
          <TabsTrigger value="custom" className="rounded-full px-3">
            <CalendarRange aria-hidden />
            Custom
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'custom' && (
        // Remount when the URL range changes from outside (back button) so the drafts follow it.
        <CustomRangeForm
          key={`${search.from}|${search.to}`}
          search={search}
          shown={shown}
          onApply={onChange}
        />
      )}
    </div>
  )
}

function CustomRangeForm({
  search,
  shown,
  onApply,
}: {
  search: DashboardSearch
  shown?: { from: string; to: string }
  onApply: (search: DashboardSearch) => void
}) {
  const fromId = useId()
  const toId = useId()
  const errorId = useId()
  const today = dhakaToday()
  const [from, setFrom] = useState(search.from ?? shown?.from ?? addDays(today, -29))
  const [to, setTo] = useState(search.to ?? shown?.to ?? today)
  const error = customRangeError(from, to, today)
  const unchanged = from === search.from && to === search.to

  return (
    <form
      aria-label="Custom date range"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (error === null) onApply({ from, to })
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={fromId} className="text-xs text-muted-foreground">
          From
        </Label>
        <Input
          id={fromId}
          type="date"
          className="w-38"
          value={from}
          min={MIN_DASHBOARD_DATE}
          max={today}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={toId} className="text-xs text-muted-foreground">
          To
        </Label>
        <Input
          id={toId}
          type="date"
          className="w-38"
          value={to}
          min={MIN_DASHBOARD_DATE}
          max={today}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={error !== null || unchanged}>
        Apply
      </Button>
      {error && (
        <p id={errorId} role="alert" className="basis-full text-xs text-destructive sm:text-right">
          {error}
        </p>
      )}
    </form>
  )
}
