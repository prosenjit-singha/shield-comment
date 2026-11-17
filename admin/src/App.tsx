import { Moon, ShieldCheck, Sun } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { resolveTheme, useUiStore } from '@/stores/ui-store'

// M0-T7 scaffold: token + component smoke screen. Replaced by the real admin shell in later modules.
const swatches = ['primary', 'secondary', 'accent', 'muted', 'destructive'] as const

export default function App() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const isDark = resolveTheme(theme) === 'dark'

  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-center gap-3">
        <ShieldCheck className="size-8 text-primary" aria-hidden />
        <div>
          <h1 className="text-2xl font-semibold">ShieldComment BD — Admin</h1>
          <p className="text-sm text-muted-foreground">
            Scaffold check · <span className="font-bangla">মন্তব্য সুরক্ষা</span>
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="ml-auto"
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? <Sun /> : <Moon />}
        </Button>
      </header>

      <Card className="rounded-3xl">
        <CardHeader>
          <CardTitle>Design tokens</CardTitle>
          <CardDescription>shadcn OKLCH variables from docs/design/base.md</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {swatches.map((name) => (
            <Badge key={name} variant="outline" className="gap-2">
              <span className="size-3 rounded-full" style={{ background: `var(--${name})` }} />
              {name}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-3xl">
        <CardContent className="flex flex-col gap-4">
          <Tabs defaultValue="buttons">
            <TabsList>
              <TabsTrigger value="buttons">Buttons</TabsTrigger>
              <TabsTrigger value="inputs">Inputs</TabsTrigger>
            </TabsList>
            <TabsContent value="buttons" className="flex flex-wrap gap-2 pt-2">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="destructive">Hide comment</Button>
                </TooltipTrigger>
                <TooltipContent>Animated tooltip (Animate UI)</TooltipContent>
              </Tooltip>
            </TabsContent>
            <TabsContent value="inputs" className="flex items-center gap-3 pt-2">
              <Input placeholder="Search workspaces…" />
              <Switch aria-label="Auto-hide scams" defaultChecked />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  )
}
