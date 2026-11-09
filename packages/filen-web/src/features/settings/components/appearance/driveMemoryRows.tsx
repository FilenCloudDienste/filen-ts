import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useSortPreferencesQuery, useViewModePreferencesQuery } from "@/features/drive/queries/drive"
import {
	setSortPreferences,
	setViewModePreferences,
	withModeToggle,
	resetPreferences,
	DEFAULT_SORT_PREFERENCES,
	DEFAULT_VIEW_MODE_PREFERENCES,
	type DrivePreferences,
	type DriveViewMode
} from "@/features/drive/lib/preferences"
import type { DriveSortBy } from "@/features/drive/lib/sort"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { PreferenceToggleRow, ResetRow } from "@/features/settings/components/settingRows"
import { saveSetting } from "@/features/settings/components/appearance/saveSetting"

type ResetTarget = "sort" | "view" | null

// The write a confirmed reset makes, or null while its preferences have not loaded.
function resetWrite(
	target: ResetTarget,
	sort: DrivePreferences<DriveSortBy> | undefined,
	view: DrivePreferences<DriveViewMode> | undefined
): { target: "sort" | "view"; write: () => Promise<void> } | null {
	if (target === "sort" && sort !== undefined) {
		return { target, write: () => setSortPreferences(resetPreferences(sort, DEFAULT_SORT_PREFERENCES.global)) }
	}

	if (target === "view" && view !== undefined) {
		return { target, write: () => setViewModePreferences(resetPreferences(view, DEFAULT_VIEW_MODE_PREFERENCES.global)) }
	}

	return null
}

// The rows giving the per-directory drive memory data model (drive/lib/preferences.ts's `mode: "perDirectory"` + per-target
// reset, which already existed with no control writing them) a real UI, mirroring mobile's Appearance
// screen: a "remember per directory" switch and a destructive "reset" action for sort and view mode
// each. Reset mirrors mobile's own confirm-then-wipe shape (screens/appearance.tsx) via the shared
// ConfirmDialog primitive, one dialog reused for whichever target the user picked.
function DriveMemoryRows() {
	const { t } = useTranslation(["settings", "common"])
	const sortQuery = useSortPreferencesQuery()
	const viewQuery = useViewModePreferencesQuery()
	const [resetTarget, setResetTarget] = useState<ResetTarget>(null)
	const [pending, setPending] = useState(false)

	async function toggleSortMode(prefs: DrivePreferences<DriveSortBy>, checked: boolean): Promise<void> {
		if (await saveSetting(() => setSortPreferences(withModeToggle(prefs, checked)))) {
			void sortQuery.refetch()
		}
	}

	async function toggleViewMode(prefs: DrivePreferences<DriveViewMode>, checked: boolean): Promise<void> {
		if (await saveSetting(() => setViewModePreferences(withModeToggle(prefs, checked)))) {
			void viewQuery.refetch()
		}
	}

	async function handleReset(): Promise<void> {
		const reset = resetWrite(resetTarget, sortQuery.data, viewQuery.data)

		if (reset === null) {
			return
		}

		setPending(true)

		const saved = await saveSetting(reset.write)

		setPending(false)

		if (!saved) {
			return
		}

		void (reset.target === "sort" ? sortQuery.refetch() : viewQuery.refetch())
		toast.success(t(reset.target === "sort" ? "settingsResetSortSuccess" : "settingsResetViewSuccess"))
		setResetTarget(null)
	}

	return (
		<>
			<PreferenceToggleRow
				title={t("settingsRememberSortPerDirectory")}
				description={t("settingsRememberSortPerDirectoryDescription")}
				checked={sortQuery.data?.mode === "perDirectory"}
				disabled={sortQuery.data === undefined}
				onCheckedChange={checked => {
					if (sortQuery.data === undefined) {
						return
					}

					void toggleSortMode(sortQuery.data, checked)
				}}
			/>
			<ResetRow
				title={t("settingsResetSort")}
				description={t("settingsResetSortDescription")}
				onReset={() => {
					setResetTarget("sort")
				}}
			/>
			<PreferenceToggleRow
				title={t("settingsRememberViewPerDirectory")}
				description={t("settingsRememberViewPerDirectoryDescription")}
				checked={viewQuery.data?.mode === "perDirectory"}
				disabled={viewQuery.data === undefined}
				onCheckedChange={checked => {
					if (viewQuery.data === undefined) {
						return
					}

					void toggleViewMode(viewQuery.data, checked)
				}}
			/>
			<ResetRow
				title={t("settingsResetView")}
				description={t("settingsResetViewDescription")}
				onReset={() => {
					setResetTarget("view")
				}}
			/>

			<ConfirmDialog
				open={resetTarget !== null}
				pending={pending}
				title={resetTarget === "sort" ? t("settingsResetSort") : t("settingsResetView")}
				body={resetTarget === "sort" ? t("settingsResetSortConfirmBody") : t("settingsResetViewConfirmBody")}
				confirmLabel={t("common:reset")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={next => {
					if (!next) {
						setResetTarget(null)
					}
				}}
				onConfirm={() => {
					void handleReset()
				}}
			/>
		</>
	)
}

export { DriveMemoryRows }
