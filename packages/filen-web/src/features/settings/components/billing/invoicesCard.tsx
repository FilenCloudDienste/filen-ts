import { useTranslation } from "react-i18next"
import { ReceiptIcon } from "lucide-react"
import { formatBillingCost, formatBillingDate } from "@/features/settings/lib/billing"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle, EmptyHeader } from "@/components/ui/empty"

interface InvoicesCardProps {
	accountQuery: AccountQuerySuccess
}

// No download column: `UserAccountSubsInvoices` carries no URL and sdk-rs has no `generateInvoice`
// equivalent — old-web's own per-row download hits a raw v3 endpoint this SDK doesn't expose, and
// this codebase never reimplements API calls in JS to work around a gap in the SDK. This table is
// read-only by construction, not by an omitted button.
function InvoicesCard({ accountQuery }: InvoicesCardProps) {
	const { t } = useTranslation("settings")
	const { subsInvoices } = accountQuery.data

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsBillingInvoicesTitle")}</CardTitle>
				<CardDescription>{t("settingsBillingInvoicesDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				{subsInvoices.length === 0 ? (
					<Empty className="rounded-2xl border-0 p-6">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ReceiptIcon />
							</EmptyMedia>
							<EmptyTitle>{t("settingsBillingInvoicesEmptyTitle")}</EmptyTitle>
							<EmptyDescription>{t("settingsBillingInvoicesEmptyDescription")}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead>
								<tr className="text-xs text-muted-foreground">
									<th className="pb-2 font-medium">{t("settingsBillingColumnPlan")}</th>
									<th className="pb-2 font-medium">{t("settingsBillingColumnGateway")}</th>
									<th className="pb-2 font-medium">{t("settingsBillingColumnCost")}</th>
									<th className="pb-2 font-medium">{t("settingsBillingColumnDate")}</th>
								</tr>
							</thead>
							<tbody>
								{subsInvoices.map(invoice => (
									<tr
										key={invoice.id}
										className="border-t border-border/60"
									>
										<td className="py-2">{invoice.planName}</td>
										<td className="py-2 capitalize">{invoice.gateway}</td>
										<td className="py-2 tabular-nums">{formatBillingCost(invoice.planCost)}</td>
										<td className="py-2 tabular-nums">{formatBillingDate(invoice.timestamp)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	)
}

export { InvoicesCard }
