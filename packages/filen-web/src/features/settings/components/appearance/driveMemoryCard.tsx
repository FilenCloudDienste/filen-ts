import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useSortPreferencesQuery, useViewModePreferencesQuery } from "@/features/drive/queries/drive"
import {
	setSortPreferences,
	setViewModePreferences,
	withSortModeToggle,
	withViewModeModeToggle,
	resetSortPreferences,
	resetViewModePreferences,
	type DrivePreferences,
	type DriveViewMode
} from "@/features/drive/lib/preferences"
import type { DriveSortBy } from "@/features/drive/lib/sort"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

interface PreferenceToggleRowProps {
	title: string
	description: string
	checked: boolean
	disabled: boolean
	onCheckedChange: (checked: boolean) => void
}

function PreferenceToggleRow({ title, description, checked, disabled, onCheckedChange }: PreferenceToggleRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-2 first:pt-0">
			<div className="flex flex-col gap-0.5">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<Switch
				checked={checked}
				disabled={disabled}
				aria-label={title}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	)
}

interface ResetRowProps {
	title: string
	description: string
	onReset: () => void
}

function ResetRow({ title, description, onReset }: ResetRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-2 last:pb-0">
			<div className="flex flex-col gap-0.5">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={onReset}
			>
				{title}
			</Button>
		</div>
	)
}

type ResetTarget = "sort" | "view" | null

// The card giving the per-directory drive memory data model (drive/lib/preferences.ts's `mode: "perDirectory"` + per-target
// reset, which already existed with no control writing them) a real UI, mirroring mobile's Appearance
// screen: a "remember per directory" switch and a destructive "reset" action for sort and view mode
// each. Reset mirrors mobile's own confirm-then-wipe shape (screens/appearance.tsx) via the shared
// ConfirmDialog primitive, one dialog reused for whichever target the user picked.
function DriveMemoryCard() {
	const { t } = useTranslation(["settings", "common"])
	const sortQuery = useSortPreferencesQuery()
	const viewQuery = useViewModePreferencesQuery()
	const [resetTarget, setResetTarget] = useState<ResetTarget>(null)
	const [pending, setPending] = useState(false)

	async function toggleSortMode(prefs: DrivePreferences<DriveSortBy>, checked: boolean): Promise<void> {
		await setSortPreferences(withSortModeToggle(prefs, checked))
		void sortQuery.refetch()
	}

	async function toggleViewMode(prefs: DrivePreferences<DriveViewMode>, checked: boolean): Promise<void> {
		await setViewModePreferences(withViewModeModeToggle(prefs, checked))
		void viewQuery.refetch()
	}

	async function handleReset(): Promise<void> {
		if (resetTarget === null) {
			return
		}

		setPending(true)

		try {
			if (resetTarget === "sort" && sortQuery.data !== undefined) {
				await setSortPreferences(resetSortPreferences(sortQuery.data))
				void sortQuery.refetch()
				toast.success(t("settingsResetSortSuccess"))
			} else if (resetTarget === "view" && viewQuery.data !== undefined) {
				await setViewModePreferences(resetViewModePreferences(viewQuery.data))
				void viewQuery.refetch()
				toast.success(t("settingsResetViewSuccess"))
			}

			setResetTarget(null)
		} finally {
			setPending(false)
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsDriveMemoryTitle")}</CardTitle>
				<CardDescription>{t("settingsDriveMemoryDescription")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col divide-y divide-border/60">
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
			</CardContent>

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
		</Card>
	)
}

export { DriveMemoryCard }
