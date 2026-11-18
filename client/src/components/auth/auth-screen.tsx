import { Link } from '@tanstack/react-router'
import { CircleAlert, Languages, ShieldCheck, WifiOff } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLanguage } from '@/hooks/use-language'
import type { AuthFailure } from '@/lib/auth-errors'

/** Shared frame for `/login` and `/register` (C2): logo, language switch, title, form, footer link. */
export function AuthScreen({
  title,
  description,
  footer,
  children,
}: {
  title: string
  description: string
  footer: ReactNode
  children: ReactNode
}) {
  const { language, toggleLanguage, content } = useLanguage()
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-muted p-4 sm:p-6">
      <Card className="relative w-full max-w-md gap-6 rounded-3xl border bg-card py-8 shadow-sm ring-0">
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-4 right-4 h-9 px-3"
          onClick={toggleLanguage}
          aria-label={content('Switch to Bangla', 'ইংরেজিতে দেখুন')}
        >
          <Languages aria-hidden />
          {language === 'en' ? 'বাংলা' : 'English'}
        </Button>
        <CardHeader className="justify-items-center gap-2 px-6 text-center sm:px-8">
          <Link
            to="/"
            aria-label="ShieldComment BD"
            className="mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <ShieldCheck className="size-6" aria-hidden />
          </Link>
          <CardTitle>
            <h1 className="text-xl font-semibold text-balance">{title}</h1>
          </CardTitle>
          <CardDescription className="text-pretty">{description}</CardDescription>
        </CardHeader>
        <CardContent className="px-6 sm:px-8">{children}</CardContent>
        <CardFooter className="justify-center px-6 text-sm text-muted-foreground sm:px-8">{footer}</CardFooter>
      </Card>
    </main>
  )
}

/** Label + `rounded-full` input + its error (wired with aria-invalid / aria-describedby). */
export function FormField({
  id,
  label,
  error,
  hint,
  ...input
}: { id: string; label: string; error?: string; hint?: string } & Omit<ComponentProps<'input'>, 'id'>) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="h-11 rounded-full px-4"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="px-4 text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="px-4 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Form-level failure (role="alert"); `data-kind` names the `AuthFailure`. */
export function AuthAlert({ id, kind, children }: { id?: string; kind: AuthFailure; children: ReactNode }) {
  const Icon = kind === 'network' ? WifiOff : CircleAlert
  return (
    <div
      id={id}
      role="alert"
      data-kind={kind}
      className="flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <p className="flex-1">{children}</p>
    </div>
  )
}
