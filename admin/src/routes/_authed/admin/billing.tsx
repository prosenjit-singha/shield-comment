import { createFileRoute } from '@tanstack/react-router'
import { CreditCard } from 'lucide-react'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/_authed/admin/billing')({
  component: BillingPage,
})

function BillingPage() {
  return (
    <PlaceholderPage
      title="Billing"
      description="Subscription payments collected through SSLCommerz (bKash, Nagad, cards) in BDT ৳."
      icon={CreditCard}
      emptyTitle="No transactions yet"
      emptyBody="Payments arrive with the SSLCommerz integration. Each transaction will appear here with its plan, amount and gateway."
    />
  )
}
