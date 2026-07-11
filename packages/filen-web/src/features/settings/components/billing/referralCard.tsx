import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/utils"
import { CopyIcon, CheckIcon } from "lucide-react"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { referralLink, referralEarnedStorage } from "@/features/settings/lib/billing"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

interface ReferralCardProps {
	accountQuery: AccountQuerySuccess
}

// Copy-link + earned-storage/referral-count read, mirroring old-web's invite card exactly (same link
// shape, same earned-storage cap — billing.ts's referralEarnedStorage). No management here: there is
// no sdk-rs op to redeem/withdraw against, this card is purely a read + a copy button.
function ReferralCard({ accountQuery }: ReferralCardProps) {
	const { t } = useTranslation("settings")
	const { refId, refStorage, refLimit, referStorage, referCount } = accountQuery.data
	const [copied, setCopied] = useState(false)
	const link = referralLink(refId)
	const earned = referralEarnedStorage(refStorage, refLimit, referStorage)

	async function handleCopy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(link)
			setCopied(true)
			toast.success(t("settingsBillingReferralCopied"))
			setTimeout(() => {
				setCopied(false)
			}, 2000)
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsBillingReferralTitle")}</CardTitle>
				<CardDescription>
					{t("settingsBillingReferralEarned", { earned: formatBytes(Number(earned)), count: Number(referCount) })}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex gap-2">
				<Input
					readOnly
					value={link}
					onFocus={e => {
						e.target.select()
					}}
				/>
				<Button
					type="button"
					variant="outline"
					onClick={() => {
						void handleCopy()
					}}
				>
					{copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
					{t("settingsBillingReferralCopy")}
				</Button>
			</CardContent>
		</Card>
	)
}

export { ReferralCard }
