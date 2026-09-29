import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { subscriptionStatus, SUBSCRIPTION_STATUS_META, formatBillingCost } from "@/features/settings/lib/billing"
import { formatShortDate } from "@/lib/formatDate"
import type { AccountQuerySuccess } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { SettingsTableBlock } from "@/features/settings/components/billing/billingTable"
import { WalletIcon } from "lucide-react"

interface SubscriptionsBlockProps {
	accountQuery: AccountQuerySuccess
}

// FREE-account reality: `subs` is empty on the shared e2e account — the empty state IS the e2e
// assertion for this block, never populated rows.
function SubscriptionsBlock({ accountQuery }: SubscriptionsBlockProps) {
	const { t } = useTranslation("settings")

	return (
		<SettingsTableBlock
			rows={accountQuery.data.subs}
			rowKey={sub => sub.id}
			columns={[
				{ header: t("settingsBillingColumnPlan"), cell: sub => sub.planName },
				{ header: t("settingsBillingColumnStorage"), className: "tabular-nums", cell: sub => formatBytes(Number(sub.storage)) },
				{ header: t("settingsBillingColumnCost"), className: "tabular-nums", cell: sub => formatBillingCost(sub.planCost) },
				{ header: t("settingsBillingColumnStarted"), className: "tabular-nums", cell: sub => formatShortDate(sub.startTimestamp) },
				{
					header: t("settingsBillingColumnStatus"),
					cell: sub => {
						const meta = SUBSCRIPTION_STATUS_META[subscriptionStatus(sub)]

						return <Badge variant={meta.badge}>{t(meta.labelKey)}</Badge>
					}
				}
			]}
			empty={{
				icon: WalletIcon,
				title: t("settingsBillingSubscriptionsEmptyTitle"),
				description: t("settingsBillingSubscriptionsEmptyDescription")
			}}
		/>
	)
}

export { SubscriptionsBlock }
