import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { subscriptionStatus, SUBSCRIPTION_STATUS_LABEL_KEY, formatBillingCost, formatBillingDate } from "@/features/settings/lib/billing"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle, EmptyHeader } from "@/components/ui/empty"
import { WalletIcon } from "lucide-react"

interface SubscriptionsCardProps {
	accountQuery: AccountQuerySuccess
}

const STATUS_BADGE_VARIANT = {
	active: "default",
	cancelled: "destructive",
	pending: "secondary"
} as const

// Plain semantic <table> markup (no ui/table.tsx primitive exists in the locked registry — the
// storage breakdown card's own precedent is "compose with existing primitives, never add to the
// registry"), reused by InvoicesCard below with the same column/empty-state shape. FREE-account
// reality: `subs` is empty on the shared e2e account — the empty state below IS
// the e2e assertion for this card, never populated rows.
function SubscriptionsCard({ accountQuery }: SubscriptionsCardProps) {
	const { t } = useTranslation("settings")
	const { subs } = accountQuery.data

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsBillingSubscriptionsTitle")}</CardTitle>
				<CardDescription>{t("settingsBillingSubscriptionsDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				{subs.length === 0 ? (
					<Empty className="rounded-2xl border-0 p-6">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<WalletIcon />
							</EmptyMedia>
							<EmptyTitle>{t("settingsBillingSubscriptionsEmptyTitle")}</EmptyTitle>
							<EmptyDescription>{t("settingsBillingSubscriptionsEmptyDescription")}</EmptyDescription>
						</EmptyHeader>
					</Empty>
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
											<td className="py-2 tabular-nums">{formatBillingDate(sub.startTimestamp)}</td>
											<td className="py-2">
												<Badge variant={STATUS_BADGE_VARIANT[status]}>
													{t(SUBSCRIPTION_STATUS_LABEL_KEY[status])}
												</Badge>
											</td>
										</tr>
									)
								})}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	)
}

export { SubscriptionsCard }
