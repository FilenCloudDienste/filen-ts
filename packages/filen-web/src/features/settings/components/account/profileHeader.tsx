import { useTranslation } from "react-i18next"
import { cn, formatBytes, storageUsageLevel } from "@filen/shared"
import { tierLabelKey } from "@/features/settings/lib/billing"
import { deriveStorageBreakdown, storagePercent, STORAGE_LEVEL_FILL_CLASS } from "@/features/settings/lib/storageBreakdown"
import type { AccountQuerySuccess } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { SettingsPanel } from "@/features/settings/components/settingsLayout"
import { AvatarPicker } from "@/features/settings/components/account/avatarPicker"

interface ProfileHeaderProps {
	accountQuery: AccountQuerySuccess
}

// Who you are at a glance, all from the account read the page already gates on. The tier follows the
// Billing page's rule (tierLabelKey: isPremium only, never a plan name) and the usage the Storage
// row's derivation, so the three surfaces cannot disagree.
function ProfileHeader({ accountQuery }: ProfileHeaderProps) {
	const { t } = useTranslation(["settings", "common"])
	const { nickName, email, isPremium, storageUsed, maxStorage, versionedStorage } = accountQuery.data
	const hasNickname = nickName !== undefined && nickName.length > 0
	const breakdown = deriveStorageBreakdown(storageUsed, maxStorage, versionedStorage)
	const usedPercent = storagePercent(breakdown.usedBytes, breakdown.maxBytes)

	return (
		<SettingsPanel className="flex flex-wrap items-center gap-4 p-5">
			<AvatarPicker accountQuery={accountQuery} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="truncate font-heading text-lg font-medium tracking-tight">{hasNickname ? nickName : email}</p>
				{hasNickname && <p className="truncate text-sm text-muted-foreground">{email}</p>}
			</div>
			<div className="flex w-full flex-col gap-2 sm:w-56">
				<div className="flex items-center justify-between gap-2">
					<Badge variant={isPremium ? "default" : "secondary"}>{t(tierLabelKey(isPremium))}</Badge>
					<span className="truncate text-xs text-muted-foreground tabular-nums">
						{t("common:storageUsage", {
							used: formatBytes(Number(breakdown.usedBytes)),
							total: formatBytes(Number(breakdown.maxBytes))
						})}
					</span>
				</div>
				{/* Decorative: the caption above already says the same thing in words. */}
				<div
					aria-hidden="true"
					className="h-1.5 w-full overflow-hidden rounded-2xl bg-muted"
				>
					<div
						className={cn("h-full", STORAGE_LEVEL_FILL_CLASS[storageUsageLevel(usedPercent)])}
						style={{ width: `${String(usedPercent)}%` }}
					/>
				</div>
			</div>
		</SettingsPanel>
	)
}

export { ProfileHeader }
