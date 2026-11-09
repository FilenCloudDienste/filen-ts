import { createFileRoute, redirect } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { GemIcon } from "lucide-react"
import { PlansView } from "@/features/settings/components/billing/plansView"
import { isDesktopBilling, validatePlansSearch } from "@/features/settings/lib/billingLinks"
import { AccountGate } from "@/features/settings/components/accountGate"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Plans and checkout, web only: the desktop app sells nothing and keeps Billing's plan display. `?plan=<id>` opens on
// that plan (a pricing-page link).
export const Route = createFileRoute("/_app/settings/plans")({
	beforeLoad: () => {
		if (isDesktopBilling()) {
			throw redirect({ to: "/settings/billing" })
		}
	},
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionPlans"), i18n.t("common:settings")] }),
	validateSearch: validatePlansSearch,
	component: PlansPage
})

function PlansPage() {
	const { t } = useTranslation("settings")
	const { plan } = Route.useSearch()

	return (
		<AccountGate
			icon={GemIcon}
			title={t("settingsSectionPlans")}
		>
			{accountQuery => (
				<PlansView
					accountQuery={accountQuery}
					planId={plan}
				/>
			)}
		</AccountGate>
	)
}
