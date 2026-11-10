import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { UserAccountSubsInvoices } from "@filen/sdk-rs"
import { DownloadIcon, ReceiptIcon } from "lucide-react"
import { formatBillingCost, toMillis } from "@/features/settings/lib/billing"
import { billingErrorLabel, downloadInvoice } from "@/features/settings/lib/billingActions"
import { formatShortDate } from "@/lib/formatDate"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SettingsTableBlock } from "@/features/settings/components/billing/billingTable"

interface InvoicesBlockProps {
	accountQuery: AccountQuerySuccess
}

function invoiceDate(invoice: UserAccountSubsInvoices): string {
	const at = toMillis(invoice.timestamp)

	return at === undefined ? "—" : formatShortDate(at)
}

// The server renders each PDF on demand and one at a time per account, so one download runs at a time here too.
function InvoicesBlock({ accountQuery }: InvoicesBlockProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const [downloadingId, setDownloadingId] = useState<string | null>(null)

	async function handleDownload(invoice: UserAccountSubsInvoices): Promise<void> {
		setDownloadingId(invoice.id)

		const outcome = await downloadInvoice(invoice)

		setDownloadingId(null)

		if (outcome.status === "error") {
			toast.error(billingErrorLabel(outcome.dto))
		}
	}

	return (
		<SettingsTableBlock
			rows={accountQuery.data.subsInvoices}
			rowKey={invoice => invoice.id}
			columns={[
				{ header: t("settingsBillingColumnPlan"), className: "font-medium", cell: invoice => invoice.planName },
				{
					header: t("settingsBillingColumnGateway"),
					className: "capitalize text-muted-foreground",
					cell: invoice => invoice.gateway
				},
				{ header: t("settingsBillingColumnCost"), className: "tabular-nums", cell: invoice => formatBillingCost(invoice.planCost) },
				{ header: t("settingsBillingColumnDate"), className: "tabular-nums text-muted-foreground", cell: invoiceDate },
				{
					header: t("settingsBillingColumnDownload"),
					className: "text-end",
					cell: invoice => (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							disabled={downloadingId !== null || !isOnline}
							title={isOnline ? undefined : t("common:offlineActionDisabled")}
							aria-label={t("settingsBillingInvoiceDownload", { date: invoiceDate(invoice) })}
							onClick={() => {
								void handleDownload(invoice)
							}}
						>
							{downloadingId === invoice.id ? <Spinner /> : <DownloadIcon />}
						</Button>
					)
				}
			]}
			empty={{
				icon: ReceiptIcon,
				title: t("settingsBillingInvoicesEmptyTitle"),
				description: t("settingsBillingInvoicesEmptyDescription")
			}}
		/>
	)
}

export { InvoicesBlock }
