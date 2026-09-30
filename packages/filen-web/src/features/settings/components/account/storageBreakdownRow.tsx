import { useTranslation } from "react-i18next"
import { cn, deriveStorageBreakdown, formatBytes, storageUsageLevel } from "@filen/shared"
import { storagePercent, STORAGE_LEVEL_FILL_CLASS } from "@/features/settings/lib/storageBreakdown"
import type { AccountQuerySuccess } from "@/queries/account"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface StorageBreakdownRowProps {
	accountQuery: AccountQuerySuccess
}

interface LegendItemProps {
	swatchClassName: string
	label: string
	bytes: bigint
}

function LegendItem({ swatchClassName, label, bytes }: LegendItemProps) {
	return (
		<div className="flex items-center gap-2 text-sm">
			<span className={cn("size-2.5 shrink-0 rounded-full", swatchClassName)} />
			<span className="text-muted-foreground">{label}</span>
			<span className="ml-auto tabular-nums sm:ml-0">{formatBytes(Number(bytes))}</span>
		</div>
	)
}

// A fuller breakdown than the drive sidebar's own single-bar StorageMeter: three segments (files /
// versioned / free) using the same `storageUsed/maxStorage/versionedStorage` fields, split by
// @filen/shared's deriveStorageBreakdown. No Progress primitive here — that component only renders
// ONE indicator; this is a plain proportional-width flex row instead.
function StorageBreakdownRow({ accountQuery }: StorageBreakdownRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const { storageUsed, maxStorage, versionedStorage } = accountQuery.data
	const breakdown = deriveStorageBreakdown(storageUsed, maxStorage, versionedStorage)
	const filesPercent = storagePercent(breakdown.filesBytes, breakdown.maxBytes)
	const versionedPercent = storagePercent(breakdown.versionedBytes, breakdown.maxBytes)
	// Warning tier is by TOTAL usage (used/max), not the files segment's own share of the bar — a
	// mostly-versioned-storage account nearing quota must still warn even though its files slice alone
	// looks small.
	const level = storageUsageLevel(storagePercent(breakdown.usedBytes, breakdown.maxBytes))

	return (
		<SettingsRow
			label={t("common:storageUsage", {
				used: formatBytes(Number(breakdown.usedBytes)),
				total: formatBytes(Number(breakdown.maxBytes))
			})}
			stacked
		>
			<div className="flex h-2 w-full overflow-hidden rounded-2xl bg-muted">
				<div
					className={cn("h-full", STORAGE_LEVEL_FILL_CLASS[level])}
					style={{ width: `${String(filesPercent)}%` }}
				/>
				<div
					className="h-full bg-chart-2"
					style={{ width: `${String(versionedPercent)}%` }}
				/>
			</div>
			<div className="flex flex-col gap-1.5 sm:flex-row sm:gap-6">
				<LegendItem
					swatchClassName={STORAGE_LEVEL_FILL_CLASS[level]}
					label={t("settingsStorageFiles")}
					bytes={breakdown.filesBytes}
				/>
				<LegendItem
					swatchClassName="bg-chart-2"
					label={t("settingsStorageVersioned")}
					bytes={breakdown.versionedBytes}
				/>
				<LegendItem
					swatchClassName="bg-muted ring-1 ring-foreground/10"
					label={t("settingsStorageFree")}
					bytes={breakdown.freeBytes}
				/>
			</div>
		</SettingsRow>
	)
}

export { StorageBreakdownRow }
