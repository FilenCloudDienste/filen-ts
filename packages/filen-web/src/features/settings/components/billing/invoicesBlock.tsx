import { useTranslation } from "react-i18next"
import { ReceiptIcon } from "lucide-react"
import { formatBillingCost } from "@/features/settings/lib/billing"
import { formatShortDate } from "@/lib/formatDate"
import type { AccountQuerySuccess } from "@/queries/account"
import { SettingsTableBlock } from "@/features/settings/components/billing/billingTable"

interface InvoicesBlockProps {
	accountQuery: AccountQuerySuccess
}

// No download column: `UserAccountSubsInvoices` carries no URL and sdk-rs has no `generateInvoice`
// equivalent — old-web's own per-row download hits a raw v3 endpoint this SDK doesn't expose, and
// this codebase never reimplements API calls in JS to work around a gap in the SDK. This table is
// read-only by construction, not by an omitted button.
function InvoicesBlock({ accountQuery }: InvoicesBlockProps) {
	const { t } = useTranslation("settings")

	return (
		<SettingsTableBlock
			rows={accountQuery.data.subsInvoices}
			rowKey={invoice => invoice.id}
			columns={[
				{ header: t("settingsBillingColumnPlan"), cell: invoice => invoice.planName },
				{ header: t("settingsBillingColumnGateway"), className: "capitalize", cell: invoice => invoice.gateway },
				{ header: t("settingsBillingColumnCost"), className: "tabular-nums", cell: invoice => formatBillingCost(invoice.planCost) },
				{ header: t("settingsBillingColumnDate"), className: "tabular-nums", cell: invoice => formatShortDate(invoice.timestamp) }
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
