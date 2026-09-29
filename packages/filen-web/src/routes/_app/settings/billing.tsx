import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { CreditCardIcon } from "lucide-react"
import { CurrentPlanRow } from "@/features/settings/components/billing/currentPlanRow"
import { SubscriptionsBlock } from "@/features/settings/components/billing/subscriptionsBlock"
import { InvoicesBlock } from "@/features/settings/components/billing/invoicesBlock"
import { ReferralRow } from "@/features/settings/components/billing/referralRow"
import { AccountGate } from "@/features/settings/components/accountGate"
import { SettingsGroup } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Read-only billing: plans/subscriptions/invoices tables (from getUserInfo — no separate billing
// read exists) + a referral copy-link + "manage on filen.io" external links wherever a mutation would
// otherwise live. Billing MANAGEMENT ops are a known SDK gap — sdk-rs has no cancelSubscription/
// generateInvoice/withdrawal equivalent — this section only ever reads.
export const Route = createFileRoute("/_app/settings/billing")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionBilling"), i18n.t("common:settings")] }),
	component: BillingPage
})

function BillingPage() {
	const { t } = useTranslation("settings")

	return (
		<AccountGate
			icon={CreditCardIcon}
			title={t("settingsSectionBilling")}
		>
			{accountQuery => (
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
			)}
		</AccountGate>
	)
}
