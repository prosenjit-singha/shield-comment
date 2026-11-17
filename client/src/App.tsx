import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useLanguage } from '@/hooks/use-language'
import { resolveTheme, useUiStore } from '@/stores/ui-store'

// Token smoke screen for the client scaffold (M0-T9). Replaced by real pages in later modules.
export default function App() {
  const { language, toggleLanguage, content } = useLanguage()
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const dark = resolveTheme(theme) === 'dark'

  return (
    <main className="min-h-svh bg-background p-6 text-foreground sm:p-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">ShieldComment BD</h1>
            <p className="text-muted-foreground">
              {content('Keep your ad comments safe', 'আপনার বিজ্ঞাপনের কমেন্ট সুরক্ষিত রাখুন')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={toggleLanguage}>
              {language === 'en' ? 'বাংলা' : 'English'}
            </Button>
            <Label htmlFor="dark-toggle">{content('Dark', 'ডার্ক')}</Label>
            <Switch
              id="dark-toggle"
              checked={dark}
              onCheckedChange={(on) => setTheme(on ? 'dark' : 'light')}
            />
          </div>
        </header>

        <Card className="rounded-3xl">
          <CardHeader>
            <CardTitle>Design tokens</CardTitle>
            <CardDescription>base.md OKLCH palette, rounded-full controls.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Button>{content('Primary', 'প্রাইমারি')}</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="destructive">Destructive</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge>{content('Hidden', 'লুকানো')}</Badge>
              <Badge variant="secondary">{content('Scam', 'প্রতারণা')}</Badge>
              <Badge variant="outline">৳ 1,499</Badge>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="you@brand.com.bd" />
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
