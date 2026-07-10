import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { useAccountQuery } from "@/queries/account"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"

// Fixed block height so the pending skeleton, the error omission, and the resolved meter all occupy
// the same vertical space — the sidebar's bottom block never jumps as the account query settles.
const BLOCK_HEIGHT = "h-9"

// Sidebar bottom-block storage usage: a slim progress bar plus one caption line, read straight from
// the account query's UserInfo (storageUsed / maxStorage bigints — see queries/account.ts). Formatted
// with the shared byte formatter. Pending renders a same-height skeleton; an errored or zero-quota
// account renders an empty same-height slot rather than a broken bar — no layout shift either way.
export function StorageMeter() {
	const { t } = useTranslation("common")
	const accountQuery = useAccountQuery()

	return (
		<div>
			<p className="mb-2 text-xs font-medium text-muted-foreground/80">{t("usage")}</p>
			{accountQuery.status === "pending" ? (
				<div className={BLOCK_HEIGHT}>
					<Skeleton className="h-2 w-full rounded-2xl" />
					<Skeleton className="mt-2 h-3 w-32 rounded-md" />
				</div>
			) : accountQuery.status === "error" ? (
				<div
					className={BLOCK_HEIGHT}
					aria-hidden="true"
				/>
			) : (
				<StorageRow
					used={Number(accountQuery.data.storageUsed)}
					max={Number(accountQuery.data.maxStorage)}
				/>
			)}
		</div>
	)
}

function StorageRow({ used, max }: { used: number; max: number }) {
	const { t } = useTranslation("common")
	const percent = max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : 0

	return (
		<div className={BLOCK_HEIGHT}>
			<Progress
				value={percent}
				aria-label={t("storage")}
			/>
			<p className="mt-2 truncate text-xs text-sidebar-foreground/70">
				{t("storageUsage", { used: formatBytes(used), total: formatBytes(max) })}
			</p>
		</div>
	)
}
