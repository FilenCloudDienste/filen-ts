import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { ArrowUpRightIcon } from "lucide-react"
import { tierLabelKey } from "@/features/settings/lib/billing"
import type { AccountQuerySuccess } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface CurrentPlanRowProps {
	accountQuery: AccountQuerySuccess
}

// The Billing page's tier — Free/Pro derived from `isPremium` only (the account-plans-stack rule in
// billing.ts), never a raw plan name; the Account profile header shows the same derivation. Total
// storage reuses the same `maxStorage` field the storage breakdown already reads, so they can never
// disagree on it. "Manage on filen.io" is the only mutation surface this row allows — external link,
// never a client-side billing-management call (sdk-rs exposes no such endpoint).
function CurrentPlanRow({ accountQuery }: CurrentPlanRowProps) {
	const { t } = useTranslation("settings")
	const { isPremium, storageUsed, maxStorage } = accountQuery.data

	return (
		<SettingsRow
			label={t("settingsBillingCurrentPlanTitle")}
			description={t("settingsStorageUsage", { used: formatBytes(Number(storageUsed)), total: formatBytes(Number(maxStorage)) })}
		>
			<Badge variant={isPremium ? "default" : "secondary"}>{t(tierLabelKey(isPremium))}</Badge>
			<a
				href="https://filen.io/pricing"
				target="_blank"
				rel="noopener noreferrer"
				className={buttonVariants({ variant: "outline" })}
			>
				{t("settingsBillingManageOnFilen")}
				<ArrowUpRightIcon
					aria-hidden="true"
					data-icon="inline-end"
				/>
			</a>
		</SettingsRow>
	)
}

export { CurrentPlanRow }
