import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { CreditCardIcon } from "lucide-react"
import { useAccountQuery } from "@/queries/account"
import { CurrentPlanCard } from "@/features/settings/components/billing/currentPlanCard"
import { SubscriptionsCard } from "@/features/settings/components/billing/subscriptionsCard"
import { InvoicesCard } from "@/features/settings/components/billing/invoicesCard"
import { ReferralCard } from "@/features/settings/components/billing/referralCard"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Read-only billing: plans/subscriptions/invoices tables (from getUserInfo — no separate billing
// read exists) + a referral copy-link + "manage on filen.io" external links wherever a mutation would
// otherwise live. Billing MANAGEMENT ops are a known SDK gap — sdk-rs has no cancelSubscription/
// generateInvoice/withdrawal equivalent — this section only ever reads. Same
// one-top-level-gate shape as the Account page.
export const Route = createFileRoute("/_app/settings/billing")({ component: BillingPage })

function BillingPage() {
	const { t } = useTranslation(["settings", "common"])
	const accountQuery = useAccountQuery()

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<div className="flex items-center gap-2">
					<CreditCardIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("settingsSectionBilling")}</h1>
				</div>
			</header>
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				{accountQuery.status === "pending" ? (
					<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
						<Skeleton className="h-24 w-full rounded-3xl" />
						<Skeleton className="h-40 w-full rounded-3xl" />
						<Skeleton className="h-40 w-full rounded-3xl" />
					</div>
				) : accountQuery.status === "error" ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<CreditCardIcon />
							</EmptyMedia>
							<EmptyTitle>{t("settingsAccountLoadError")}</EmptyTitle>
						</EmptyHeader>
						<EmptyContent>
							<Button
								variant="outline"
								onClick={() => {
									void accountQuery.refetch()
								}}
							>
								{t("common:tryAgain")}
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
						<CurrentPlanCard accountQuery={accountQuery} />
						<SubscriptionsCard accountQuery={accountQuery} />
						<InvoicesCard accountQuery={accountQuery} />
						<ReferralCard accountQuery={accountQuery} />
					</div>
				)}
			</div>
		</>
	)
}
