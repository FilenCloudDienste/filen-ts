import { useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { CopyIcon, CheckIcon } from "lucide-react"
import { copyText } from "@/lib/copyText"
import { referralLink, referralEarnedStorage } from "@/features/settings/lib/billing"
import type { AccountQuerySuccess } from "@/queries/account"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface ReferralRowProps {
	accountQuery: AccountQuerySuccess
}

// Copy-link + earned-storage/referral-count read, mirroring old-web's invite card exactly (same link
// shape, same earned-storage cap — billing.ts's referralEarnedStorage). No management here: there is
// no sdk-rs op to redeem/withdraw against, this row is purely a read + a copy button.
function ReferralRow({ accountQuery }: ReferralRowProps) {
	const { t } = useTranslation("settings")
	const { refId, refStorage, refLimit, referStorage, referCount } = accountQuery.data
	const [copied, setCopied] = useState(false)
	const link = referralLink(refId)
	const earned = referralEarnedStorage(refStorage, refLimit, referStorage)

	async function handleCopy(): Promise<void> {
		if (!(await copyText(link, t("settingsBillingReferralCopied")))) {
			return
		}

		setCopied(true)
		setTimeout(() => {
			setCopied(false)
		}, 2000)
	}

	return (
		<SettingsRow
			label={t("settingsBillingReferralLinkLabel")}
			description={t("settingsBillingReferralEarned", { earned: formatBytes(Number(earned)), count: Number(referCount) })}
			htmlFor="referral-link"
			stacked
		>
			<div className="flex gap-2">
				<Input
					id="referral-link"
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
			</div>
		</SettingsRow>
	)
}

export { ReferralRow }
