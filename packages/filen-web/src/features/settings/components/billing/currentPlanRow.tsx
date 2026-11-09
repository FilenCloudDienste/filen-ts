import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { formatBytes, isProAccount } from "@filen/shared"
import { tierLabelKey } from "@/features/settings/lib/billing"
import { isDesktopBilling } from "@/features/settings/lib/billingLinks"
import type { AccountQuerySuccess } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface CurrentPlanRowProps {
	accountQuery: AccountQuerySuccess
}

// The Billing page's tier — Free/Pro derived from `isProAccount(subs)` only (the account-plans-stack rule in
// billing.ts), never a raw plan name; the Account profile header shows the same derivation. Total
// storage reuses the same `maxStorage` field the storage breakdown already reads, so they can never
// disagree on it. The web app opens its plans from here; the desktop app links to the web instead.
function CurrentPlanRow({ accountQuery }: CurrentPlanRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const { subs, storageUsed, maxStorage } = accountQuery.data
	const isPro = isProAccount(subs)
	const usage = t("common:storageUsage", { used: formatBytes(Number(storageUsed)), total: formatBytes(Number(maxStorage)) })

	return (
		<SettingsRow
			label={t("settingsBillingCurrentPlanTitle")}
			description={
				isPro ? (
					usage
				) : (
					<>
						{usage}
						<span className="mt-1 block text-xs">{t("settingsBillingFreeTierNote")}</span>
					</>
				)
			}
		>
			<Badge variant={isPro ? "default" : "secondary"}>{t(tierLabelKey(isPro))}</Badge>
			{isDesktopBilling() ? null : (
				<Link
					to="/settings/plans"
					className={buttonVariants({ variant: "outline" })}
				>
					{t("settingsBillingSeePlans")}
				</Link>
			)}
		</SettingsRow>
	)
}

export { CurrentPlanRow }
