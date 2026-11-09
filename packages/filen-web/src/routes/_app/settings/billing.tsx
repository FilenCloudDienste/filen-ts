import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { CreditCardIcon } from "lucide-react"
import { CurrentPlanRow } from "@/features/settings/components/billing/currentPlanRow"
import { SubscriptionsBlock } from "@/features/settings/components/billing/subscriptionsBlock"
import { InvoicesBlock } from "@/features/settings/components/billing/invoicesBlock"
import { ReferralRow } from "@/features/settings/components/billing/referralRow"
import { isDesktopBilling, WEB_BILLING_URL } from "@/features/settings/lib/billingLinks"
import { AccountGate } from "@/features/settings/components/accountGate"
import { SettingsGroup, SettingsLinkRow } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Plan, subscriptions (cancel, withdrawal), invoices and referral, all read from getUserInfo; the plans are their own
// page. The desktop app keeps the plan display and sends everything else to the web app.
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
			{accountQuery =>
				isDesktopBilling() ? (
					<>
						<SettingsGroup title={t("settingsGroupPlan")}>
							<CurrentPlanRow accountQuery={accountQuery} />
							<SettingsLinkRow
								href={WEB_BILLING_URL}
								label={t("settingsBillingManageOnWeb")}
							/>
						</SettingsGroup>
						<SettingsGroup title={t("settingsBillingReferralTitle")}>
							<ReferralRow accountQuery={accountQuery} />
						</SettingsGroup>
					</>
				) : (
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
				)
			}
		</AccountGate>
	)
}
