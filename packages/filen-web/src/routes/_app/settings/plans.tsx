import { createFileRoute, redirect, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { GemIcon } from "lucide-react"
import { PlansView } from "@/features/settings/components/billing/plansView"
import { isDesktopBilling, parsePlanId } from "@/features/settings/lib/billingLinks"
import { AccountGate } from "@/features/settings/components/accountGate"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Plans and checkout, web only: the desktop app sells nothing and keeps Billing's plan display. A layout:
// plans.index (/settings/plans) and plans.$plan (/settings/plans/<id>, a pricing-page link that opens on that plan)
// only select, this renders the page for both.
export const Route = createFileRoute("/_app/settings/plans")({
	beforeLoad: () => {
		if (isDesktopBilling()) {
			throw redirect({ to: "/settings/billing" })
		}
	},
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionPlans"), i18n.t("common:settings")] }),
	component: PlansPage
})

function PlansPage() {
	const { t } = useTranslation("settings")
	const plan = useParams({ from: "/_app/settings/plans/$plan", shouldThrow: false, select: params => parsePlanId(params.plan) })

	return (
		<AccountGate
			icon={GemIcon}
			title={t("settingsSectionPlans")}
			wide
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
