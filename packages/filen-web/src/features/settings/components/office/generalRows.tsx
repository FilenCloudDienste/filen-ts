import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { MAX_AUTHOR_INITIALS_LENGTH, OFFICE_AUTOSAVE_DELAYS_MS, normalizeAuthorInitials } from "@filen/shared"
import { AuthorNameDialog } from "@/features/office/components/authorNameDialog"
import { saveAuthorName, useOfficeSettings } from "@/features/office/lib/officeSettings"
import { PreferenceToggleRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { saveSyncedOfficeSetting } from "@/features/settings/components/office/syncedSetting"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { Button } from "@/components/ui/button"
import { useIsOnline } from "@/lib/useIsOnline"

// Office → General: the author comments and tracked changes carry, and autosave. Synced (features/office/lib/
// officeSettings.ts): written only once the file was read, and only online.
export function OfficeGeneralRows() {
	const { t } = useTranslation(["settings", "common"])
	const settings = useOfficeSettings()
	const online = useIsOnline()
	const disabled = !settings.loaded || !online
	const offlineReason = online ? undefined : t("common:offlineActionDisabled")
	const [editing, setEditing] = useState<"name" | "initials" | null>(null)
	const [pending, setPending] = useState(false)

	function submitName(name: string): void {
		setPending(true)
		saveAuthorName(name).then(
			() => {
				setPending(false)
				setEditing(null)
			},
			() => {
				setPending(false)
				toast.error(t("settingsDocumentsSaveFailed"))
			}
		)
	}

	function submitInitials(initials: string | null): void {
		saveSyncedOfficeSetting("authorInitials", initials === null ? null : (normalizeAuthorInitials(initials) ?? null))
		setEditing(null)
	}

	return (
		<>
			<SettingsRow
				label={t("settingsDocumentsAuthorName")}
				description={t("settingsDocumentsAuthorNameDescription")}
			>
				<div className="flex min-w-0 items-center gap-3">
					<span className="truncate text-sm text-muted-foreground">
						{settings.authorName ?? t("settingsDocumentsAuthorNameUnset")}
					</span>
					<Button
						type="button"
						variant="outline"
						disabled={disabled}
						title={offlineReason}
						aria-label={t("settingsDocumentsAuthorName")}
						onClick={() => {
							setEditing("name")
						}}
					>
						{t("settingsDocumentsAuthorNameEdit")}
					</Button>
				</div>
			</SettingsRow>
			<SettingsRow
				label={t("settingsOfficeAuthorInitials")}
				description={t("settingsOfficeAuthorInitialsDescription")}
			>
				<div className="flex min-w-0 items-center gap-3">
					<span className="truncate text-sm text-muted-foreground">
						{settings.authorInitials ?? t("settingsOfficeAuthorInitialsFromName")}
					</span>
					<Button
						type="button"
						variant="outline"
						disabled={disabled}
						title={offlineReason}
						aria-label={t("settingsOfficeAuthorInitials")}
						onClick={() => {
							setEditing("initials")
						}}
					>
						{t("settingsDocumentsAuthorNameEdit")}
					</Button>
				</div>
			</SettingsRow>
			<PreferenceToggleRow
				title={t("settingsDocumentsAutosave")}
				description={t("settingsOfficeAutosaveDescription")}
				checked={settings.autosave}
				disabled={disabled}
				disabledReason={offlineReason}
				onCheckedChange={checked => {
					saveSyncedOfficeSetting("autosave", checked)
				}}
			/>
			<SettingsSelectRow
				label={t("settingsOfficeAutosaveDelay")}
				description={t("settingsOfficeAutosaveDelayDescription")}
				id="office-autosave-delay"
				options={OFFICE_AUTOSAVE_DELAYS_MS.map(delay => ({
					value: String(delay),
					label:
						delay < 60_000
							? t("settingsOfficeAutosaveDelaySeconds", { count: delay / 1000 })
							: t("settingsOfficeAutosaveDelayMinutes", { count: delay / 60_000 })
				}))}
				value={String(settings.autosaveDelayMs)}
				disabled={disabled || !settings.autosave}
				onChange={value => {
					const delay = OFFICE_AUTOSAVE_DELAYS_MS.find(option => String(option) === value)

					if (delay !== undefined) {
						saveSyncedOfficeSetting("autosaveDelayMs", delay)
					}
				}}
			/>
			<AuthorNameDialog
				open={editing === "name"}
				pending={pending}
				initialValue={settings.authorName}
				onOpenChange={open => {
					if (!open) {
						setEditing(null)
					}
				}}
				onSubmit={submitName}
			/>
			<InputDialog
				open={editing === "initials"}
				pending={false}
				title={t("settingsOfficeAuthorInitialsDialogTitle")}
				body={t("settingsOfficeAuthorInitialsDialogBody", { max: MAX_AUTHOR_INITIALS_LENGTH })}
				label={t("settingsOfficeAuthorInitialsLabel")}
				initialValue={settings.authorInitials ?? ""}
				autoComplete="off"
				maxLength={MAX_AUTHOR_INITIALS_LENGTH}
				submitLabel={t("settingsOfficeAuthorInitialsSave")}
				secondaryAction={
					settings.authorInitials === null
						? undefined
						: {
								label: t("settingsOfficeAuthorInitialsUseName"),
								onClick: () => {
									submitInitials(null)
								}
							}
				}
				validate={value => normalizeAuthorInitials(value) !== undefined}
				onOpenChange={open => {
					if (!open) {
						setEditing(null)
					}
				}}
				onSubmit={submitInitials}
			/>
		</>
	)
}
