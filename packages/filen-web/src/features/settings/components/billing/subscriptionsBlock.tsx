import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { subscriptionStatus, SUBSCRIPTION_STATUS_LABEL_KEY, formatBillingCost } from "@/features/settings/lib/billing"
import { formatShortDate } from "@/lib/formatDate"
import type { AccountQuerySuccess } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"
import { EmptyMessage } from "@/components/emptyMessage"
import { WalletIcon } from "lucide-react"

interface SubscriptionsBlockProps {
	accountQuery: AccountQuerySuccess
}

const STATUS_BADGE_VARIANT = {
	active: "default",
	cancelled: "destructive",
	pending: "secondary"
} as const

// Plain semantic <table> markup (no ui/table.tsx primitive exists in the locked registry — the
// storage breakdown row's own precedent is "compose with existing primitives, never add to the
// registry"), reused by InvoicesBlock with the same column/empty-state shape. FREE-account
// reality: `subs` is empty on the shared e2e account — the empty state below IS the e2e assertion
// for this block, never populated rows.
function SubscriptionsBlock({ accountQuery }: SubscriptionsBlockProps) {
	const { t } = useTranslation("settings")
	const { subs } = accountQuery.data

	return (
		<SettingsBlock>
			{subs.length === 0 ? (
				<EmptyMessage
					className="rounded-none border-0 p-4"
					icon={WalletIcon}
					title={t("settingsBillingSubscriptionsEmptyTitle")}
					description={t("settingsBillingSubscriptionsEmptyDescription")}
				/>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="text-xs text-muted-foreground">
								<th className="pb-2 font-medium">{t("settingsBillingColumnPlan")}</th>
								<th className="pb-2 font-medium">{t("settingsBillingColumnStorage")}</th>
								<th className="pb-2 font-medium">{t("settingsBillingColumnCost")}</th>
								<th className="pb-2 font-medium">{t("settingsBillingColumnStarted")}</th>
								<th className="pb-2 font-medium">{t("settingsBillingColumnStatus")}</th>
							</tr>
						</thead>
						<tbody>
							{subs.map(sub => {
								const status = subscriptionStatus(sub)

								return (
									<tr
										key={sub.id}
										className="border-t border-border/60"
									>
										<td className="py-2">{sub.planName}</td>
										<td className="py-2 tabular-nums">{formatBytes(Number(sub.storage))}</td>
										<td className="py-2 tabular-nums">{formatBillingCost(sub.planCost)}</td>
										<td className="py-2 tabular-nums">{formatShortDate(sub.startTimestamp)}</td>
										<td className="py-2">
											<Badge variant={STATUS_BADGE_VARIANT[status]}>{t(SUBSCRIPTION_STATUS_LABEL_KEY[status])}</Badge>
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			)}
		</SettingsBlock>
	)
}

export { SubscriptionsBlock }
