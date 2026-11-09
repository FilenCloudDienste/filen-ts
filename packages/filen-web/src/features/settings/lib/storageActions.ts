import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import {
	RELOAD_ROWS,
	clearRow,
	clearRows,
	removeModel,
	type CacheRow,
	type ClearableRow,
	type ClearAllResult
} from "@/features/settings/lib/localCaches"
import { finishWithReload, showReports, type CacheClearReport } from "@/features/settings/lib/cacheReload"
import { log } from "@/lib/log"

// The Storage page's actions: run a clear, tell the user how it went, then either reload every tab (a cache open tabs
// keep in memory) or measure again what changed.

export const STORAGE_QUERY_ROOT = ["settings", "storage"] as const

export const ROW_LABEL_KEY = {
	thumbnails: "storageThumbnails",
	videos: "storageVideos",
	music: "storageMusic",
	queryCache: "storageQueryCache",
	model: "storageModel",
	browserCache: "storageBrowserCache",
	networkDrive: "storageNetworkDrive"
} as const satisfies Record<CacheRow, string>

export function rowLabel(row: CacheRow): string {
	return i18n.t(`settings:${ROW_LABEL_KEY[row]}`)
}

export function rowList(rows: readonly CacheRow[]): string {
	return new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(rows.map(rowLabel))
}

// What a clear ended in, for the page: it reloads, or it stays and its sizes are measured again.
export type ClearEnd = "reloading" | "stayed"

function remeasure(rows: readonly CacheRow[]): void {
	for (const row of rows) {
		void queryClient.invalidateQueries({ queryKey: [...STORAGE_QUERY_ROOT, row] })
	}

	void queryClient.invalidateQueries({ queryKey: [...STORAGE_QUERY_ROOT, "estimate"] })
}

function end(reports: CacheClearReport[], reload: boolean, rows: readonly CacheRow[]): ClearEnd {
	if (reload) {
		if (finishWithReload(reports)) {
			return "reloading"
		}
	} else {
		showReports(reports)
	}

	remeasure(rows)

	return "stayed"
}

export async function runRowClear(row: ClearableRow): Promise<ClearEnd> {
	const name = rowLabel(row)

	return clearRow(row).then(
		outcome => {
			if (outcome.kind === "skipped") {
				return end([{ kind: "info", message: i18n.t("settings:storageNetworkDriveSkipped") }], false, [row])
			}

			return end([{ kind: "success", message: i18n.t("settings:storageCleared", { name }) }], RELOAD_ROWS.has(row), [row])
		},
		() => end([{ kind: "error", message: i18n.t("settings:storageClearError", { name }) }], false, [row])
	)
}

export function clearAllReports(result: ClearAllResult): CacheClearReport[] {
	const reports: CacheClearReport[] = []

	if (result.failed.length > 0) {
		reports.push({ kind: "error", message: i18n.t("settings:storageClearAllSomeError", { list: rowList(result.failed) }) })
	} else if (result.cleared.length > 0) {
		reports.push({ kind: "success", message: i18n.t("settings:storageClearAllSuccess") })
	}

	if (result.skipped.includes("networkDrive")) {
		reports.push({ kind: "info", message: i18n.t("settings:storageNetworkDriveSkipped") })
	}

	return reports
}

export async function runClearAll(rows: readonly ClearableRow[]): Promise<ClearEnd> {
	const result = await clearRows(rows)

	return end(
		clearAllReports(result),
		result.cleared.some(row => RELOAD_ROWS.has(row)),
		rows
	)
}

export async function runModelRemoval(): Promise<ClearEnd> {
	return removeModel().then(
		() => {
			toast.success(i18n.t("settings:storageModelRemoved"))
			remeasure(["model"])

			return "stayed" as const
		},
		(e: unknown) => {
			log.error("storage.caches", "removing the model failed", e)
			toast.error(i18n.t("settings:storageModelRemoveError"))
			remeasure(["model"])

			return "stayed" as const
		}
	)
}
