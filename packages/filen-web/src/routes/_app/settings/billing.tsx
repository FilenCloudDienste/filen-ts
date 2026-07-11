import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { CreditCardIcon } from "lucide-react"
import { SettingsPlaceholder } from "@/features/settings/components/settingsPlaceholder"

// Read-only billing placeholder (D1: plans/subscriptions/invoices tables + referral copy-link +
// "manage on filen.io" links) — ships in a later wave. Billing MANAGEMENT ops stay a reported gap
// (not in the sdk-rs Client) regardless of wave; only reads will ever land here.
export const Route = createFileRoute("/_app/settings/billing")({ component: BillingPage })

function BillingPage() {
	const { t } = useTranslation("settings")

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<div className="flex items-center gap-2">
					<CreditCardIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("settingsSectionBilling")}</h1>
				</div>
			</header>
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				<SettingsPlaceholder
					icon={CreditCardIcon}
					title={t("settingsSectionBilling")}
				/>
			</div>
		</>
	)
}
