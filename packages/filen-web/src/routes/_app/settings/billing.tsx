import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { CreditCardIcon } from "lucide-react"
import { useAccountQuery } from "@/queries/account"
import { CurrentPlanRow } from "@/features/settings/components/billing/currentPlanRow"
import { SubscriptionsBlock } from "@/features/settings/components/billing/subscriptionsBlock"
import { InvoicesBlock } from "@/features/settings/components/billing/invoicesBlock"
import { ReferralRow } from "@/features/settings/components/billing/referralRow"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Read-only billing: plans/subscriptions/invoices tables (from getUserInfo — no separate billing
// read exists) + a referral copy-link + "manage on filen.io" external links wherever a mutation would
// otherwise live. Billing MANAGEMENT ops are a known SDK gap — sdk-rs has no cancelSubscription/
// generateInvoice/withdrawal equivalent — this section only ever reads. Same
// one-top-level-gate shape as the Account page.
export const Route = createFileRoute("/_app/settings/billing")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionBilling"), i18n.t("common:settings")] }),
	component: BillingPage
})

function BillingPage() {
	const { t } = useTranslation(["settings", "common"])
	const accountQuery = useAccountQuery()

	return (
		<SettingsPage
			icon={CreditCardIcon}
			title={t("settingsSectionBilling")}
		>
			{accountQuery.data !== undefined ? (
				<>
					<SettingsGroup title={t("settingsGroupPlan")}>
						<CurrentPlanRow accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup
						title={t("settingsBillingSubscriptionsTitle")}
						description={t("settingsBillingSubscriptionsDescription")}
					>
						<SubscriptionsBlock accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup
						title={t("settingsBillingInvoicesTitle")}
						description={t("settingsBillingInvoicesDescription")}
					>
						<InvoicesBlock accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup title={t("settingsBillingReferralTitle")}>
						<ReferralRow accountQuery={accountQuery} />
					</SettingsGroup>
				</>
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
				<LoadingState size="lg" />
			)}
		</SettingsPage>
	)
}
