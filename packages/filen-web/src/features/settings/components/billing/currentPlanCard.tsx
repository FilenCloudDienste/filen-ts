import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { tierLabelKey } from "@/features/settings/lib/billing"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardFooter, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface CurrentPlanCardProps {
	accountQuery: AccountQuerySuccess
}

// The one place the "current plan card" shows a tier — Free/Pro derived from `isPremium` only (the
// account-plans-stack rule in billing.ts), never a raw plan name. Total storage reuses the same
// `maxStorage` field storageBreakdownCard already reads, so the two cards can never disagree on it.
// "Manage on filen.io" is the only mutation surface this card allows — external link, never a client-side
// billing-management call (sdk-rs exposes no such endpoint).
function CurrentPlanCard({ accountQuery }: CurrentPlanCardProps) {
	const { t } = useTranslation("settings")
	const { isPremium, storageUsed, maxStorage } = accountQuery.data

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsBillingCurrentPlanTitle")}</CardTitle>
				<CardDescription>
					{t("settingsStorageUsage", { used: formatBytes(Number(storageUsed)), total: formatBytes(Number(maxStorage)) })}
				</CardDescription>
				<CardAction>
					<Badge variant={isPremium ? "default" : "secondary"}>{t(tierLabelKey(isPremium))}</Badge>
				</CardAction>
			</CardHeader>
			<CardFooter>
				<Button
					variant="outline"
					render={
						<a
							href="https://filen.io/pricing"
							target="_blank"
							rel="noopener noreferrer"
						/>
					}
				>
					{t("settingsBillingManageOnFilen")}
				</Button>
			</CardFooter>
		</Card>
	)
}

export { CurrentPlanCard }
