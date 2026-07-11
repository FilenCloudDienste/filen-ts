import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { deriveStorageBreakdown, storagePercent } from "@/features/settings/lib/storageBreakdown"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

interface StorageBreakdownCardProps {
	accountQuery: AccountQuerySuccess
}

interface LegendRowProps {
	swatchClassName: string
	label: string
	bytes: bigint
}

function LegendRow({ swatchClassName, label, bytes }: LegendRowProps) {
	return (
		<div className="flex items-center gap-2 text-sm">
			<span className={`size-2.5 shrink-0 rounded-full ${swatchClassName}`} />
			<span className="text-muted-foreground">{label}</span>
			<span className="ml-auto tabular-nums">{formatBytes(Number(bytes))}</span>
		</div>
	)
}

// A fuller breakdown than the drive sidebar's own single-bar StorageMeter: three segments (files /
// versioned / free) using the same `storageUsed/maxStorage/versionedStorage` fields, math straight
// from old-web's settings/general bar (storageBreakdown.ts). No Progress primitive here — that
// component only renders ONE indicator; this is a plain proportional-width flex row instead.
function StorageBreakdownCard({ accountQuery }: StorageBreakdownCardProps) {
	const { t } = useTranslation("settings")
	const { storageUsed, maxStorage, versionedStorage } = accountQuery.data
	const breakdown = deriveStorageBreakdown(storageUsed, maxStorage, versionedStorage)
	const filesPercent = storagePercent(breakdown.filesBytes, breakdown.maxBytes)
	const versionedPercent = storagePercent(breakdown.versionedBytes, breakdown.maxBytes)

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsStorageTitle")}</CardTitle>
				<CardDescription>
					{t("settingsStorageUsage", {
						used: formatBytes(Number(breakdown.usedBytes)),
						total: formatBytes(Number(breakdown.maxBytes))
					})}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex h-2 w-full overflow-hidden rounded-2xl bg-muted">
					<div
						className="h-full bg-chart-1"
						style={{ width: `${String(filesPercent)}%` }}
					/>
					<div
						className="h-full bg-chart-2"
						style={{ width: `${String(versionedPercent)}%` }}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<LegendRow
						swatchClassName="bg-chart-1"
						label={t("settingsStorageFiles")}
						bytes={breakdown.filesBytes}
					/>
					<LegendRow
						swatchClassName="bg-chart-2"
						label={t("settingsStorageVersioned")}
						bytes={breakdown.versionedBytes}
					/>
					<LegendRow
						swatchClassName="bg-muted"
						label={t("settingsStorageFree")}
						bytes={breakdown.freeBytes}
					/>
				</div>
			</CardContent>
		</Card>
	)
}

export { StorageBreakdownCard }
