import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { SettingsBlock, SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import {
	useCacheSizes,
	useNetworkDriveCacheBytes,
	useOriginUsage,
	type RowSize
} from "@/features/settings/components/storage/useStorageSizes"
import {
	CACHE_ROWS,
	DESKTOP_ROWS,
	RELOAD_ROWS,
	clearAllRows,
	type CacheRow,
	type ClearableRow,
	type MeasuredRow
} from "@/features/settings/lib/localCaches"
import { ROW_LABEL_KEY, rowList, runClearAll, runModelRemoval, runRowClear, type ClearEnd } from "@/features/settings/lib/storageActions"
import { showReports, takeReportsAfterReload } from "@/features/settings/lib/cacheReload"
import { storageUsage } from "@/features/settings/lib/storageUsage.logic"
import { hasUnloadHold } from "@/lib/unloadGuard"
import { desktopBridge } from "@/lib/desktop"

const ROW_DESCRIPTION_KEY = {
	thumbnails: "storageThumbnailsDescription",
	videos: "storageVideosDescription",
	music: "storageMusicDescription",
	queryCache: "storageQueryCacheDescription",
	model: "storageModelDescription",
	browserCache: "storageBrowserCacheDescription",
	networkDrive: "storageNetworkDriveDescription"
} as const satisfies Record<CacheRow, string>

const ROW_BODY_KEY = {
	thumbnails: "storageThumbnailsBody",
	videos: "storageVideosBody",
	music: "storageMusicBody",
	queryCache: "storageQueryCacheBody",
	browserCache: "storageBrowserCacheBody",
	networkDrive: "storageNetworkDriveBody"
} as const satisfies Record<ClearableRow, string>

type Target = CacheRow | "all"

// One width for every row's action slot (Clear, Remove, or none for Other), so the sizes before it share a column.
const ACTION_SLOT_CLASS = "flex min-w-24 justify-end"

interface RowSizeTextProps {
	size: RowSize
}

function RowSizeText({ size }: RowSizeTextProps) {
	const { t } = useTranslation("settings")

	if (size === undefined) {
		return <Skeleton className="h-4 w-14" />
	}

	if (size === null) {
		return (
			<span
				className="text-sm text-muted-foreground tabular-nums"
				title={t("storageSizeUnknownHint")}
				aria-label={t("storageSizeUnknownHint")}
			>
				{t("storageSizeUnknown")}
			</span>
		)
	}

	return <span className="text-sm text-muted-foreground tabular-nums">{formatBytes(size)}</span>
}

interface TotalTextProps {
	label: string
	total: number | undefined
}

// The group's total, beside its title; the label is for screen readers, the title line already says what it counts.
function TotalText({ label, total }: TotalTextProps) {
	return (
		<span className="flex shrink-0 items-center text-xs font-medium text-muted-foreground tabular-nums">
			<span className="sr-only">{`${label}: `}</span>
			{total === undefined ? <Skeleton className="h-3.5 w-14" /> : formatBytes(total)}
		</span>
	)
}

function run(target: Target, clearAll: readonly ClearableRow[]): Promise<ClearEnd> {
	if (target === "all") {
		return runClearAll(clearAll)
	}

	if (target === "model") {
		return runModelRemoval()
	}

	return runRowClear(target)
}

// The local caches as one settings group: the total in its header, each cache with its size and its own clear, the
// unnamed rest as Other, then Clear all. Sizes are measured while this is mounted only.
function StorageCaches() {
	const { t } = useTranslation(["settings", "common"])
	const desktop = desktopBridge() !== undefined
	const rows = CACHE_ROWS.filter(row => desktop || !DESKTOP_ROWS.has(row))
	const measured = useCacheSizes(rows.filter((row): row is MeasuredRow => row !== "networkDrive"))
	const origin = useOriginUsage()
	const networkDrive = useNetworkDriveCacheBytes()
	const [confirm, setConfirm] = useState<Target | null>(null)
	const [running, setRunning] = useState<Target | null>(null)

	useEffect(() => {
		showReports(takeReportsAfterReload())
	}, [])

	const sizes: Partial<Record<CacheRow, RowSize>> = { ...measured, networkDrive }
	const modelBytes = sizes.model
	// The model row shows only while a model is on disk.
	const visibleRows = rows.filter(row => row !== "model" || (typeof modelBytes === "number" && modelBytes > 0))
	const usage = storageUsage({ rows: rows.map(row => [row, sizes[row]] as const), origin })
	const clearAll = clearAllRows(desktop, networkDrive)

	function start(target: Target): void {
		setRunning(target)
		void run(target, clearAll).then(outcome => {
			// A reloading tab keeps the dialog up, spinning, until the page goes.
			if (outcome === "stayed") {
				setRunning(null)
				setConfirm(null)
			}
		})
	}

	function dialogBody(target: Target): string {
		const reloads = target === "all" || RELOAD_ROWS.has(target)
		const busy = reloads && hasUnloadHold() ? ` ${t("storageBusyNote")}` : ""

		if (target === "all") {
			return t("storageClearAllBody", { list: rowList(clearAll) }) + busy
		}

		if (target === "model") {
			return t("storageModelBody", { size: formatBytes(typeof modelBytes === "number" ? modelBytes : 0) })
		}

		return t(ROW_BODY_KEY[target]) + busy
	}

	function dialogTitle(target: Target): string {
		if (target === "all") {
			return t("storageClearAllTitle")
		}

		if (target === "model") {
			return t("storageModelTitle")
		}

		return t("storageClearTitle", { name: t(ROW_LABEL_KEY[target]) })
	}

	function confirmLabel(target: Target): string {
		if (target === "all") {
			return t("storageClearAll")
		}

		return target === "model" ? t("storageRemove") : t("storageClear")
	}

	return (
		<>
			<SettingsGroup
				title={t("storageGroupCaches")}
				description={t("storageGroupCachesDescription")}
				aside={
					<TotalText
						label={desktop ? t("storageTotalDevice") : t("storageTotalBrowser")}
						total={usage.total}
					/>
				}
			>
				{visibleRows.map(row => {
					const size = sizes[row]
					const label = t(ROW_LABEL_KEY[row])
					const action = row === "model" ? t("storageRemove") : t("storageClear")

					return (
						<SettingsRow
							key={row}
							label={label}
							description={t(ROW_DESCRIPTION_KEY[row])}
						>
							<RowSizeText size={size} />
							<div className={ACTION_SLOT_CLASS}>
								<Button
									variant="outline"
									aria-label={`${action}: ${label}`}
									disabled={running !== null || typeof size !== "number" || size === 0}
									onClick={() => {
										setConfirm(row)
									}}
								>
									{running === row ? <Spinner data-icon="inline-start" /> : null}
									{action}
								</Button>
							</div>
						</SettingsRow>
					)
				})}
				{usage.other !== undefined && usage.other > 0 ? (
					<SettingsRow
						label={t("storageOther")}
						description={t("storageOtherDescription")}
					>
						<RowSizeText size={usage.other} />
						<div
							aria-hidden="true"
							className={ACTION_SLOT_CLASS}
						/>
					</SettingsRow>
				) : null}
				<SettingsBlock className="flex justify-end">
					<Button
						variant="outline"
						disabled={running !== null || clearAll.length === 0}
						onClick={() => {
							setConfirm("all")
						}}
					>
						{running === "all" ? <Spinner data-icon="inline-start" /> : null}
						{t("storageClearAll")}
					</Button>
				</SettingsBlock>
			</SettingsGroup>
			<ConfirmDialog
				open={confirm !== null}
				pending={running !== null}
				title={confirm === null ? "" : dialogTitle(confirm)}
				body={confirm === null ? "" : dialogBody(confirm)}
				confirmLabel={confirm === null ? "" : confirmLabel(confirm)}
				cancelLabel={t("common:cancel")}
				destructive={confirm === "model" || confirm === "all"}
				onOpenChange={next => {
					if (!next) {
						setConfirm(null)
					}
				}}
				onConfirm={() => {
					if (confirm !== null) {
						start(confirm)
					}
				}}
			/>
		</>
	)
}

export { StorageCaches }
