import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { DESKTOP_LOCK_AFTER_SECONDS } from "@filen/shared/desktopLock"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import { useDesktopLock } from "@/features/desktop/lib/lock"
import { setDesktopPref, useDesktopPrefs } from "@/features/desktop/lib/prefs"
import { PinDialog, type PinDialogMode } from "@/features/desktop/components/pinDialog"
import { Button } from "@/components/ui/button"
import { desktopBridge } from "@/lib/desktop"

// "Lock after": inactivity in Filen's windows, hidden time included. The prefs are loaded by the Desktop page.
function LockAfterRow() {
	const { t } = useTranslation("settings")
	const value = useDesktopPrefs(state => state.prefs?.lockAfterSeconds)
	const [saving, setSaving] = useState(false)

	return (
		<SettingsSelectRow
			label={t("settingsDesktopLockAfter")}
			description={t("settingsDesktopLockAfterDescription")}
			id="desktop-lock-after"
			options={DESKTOP_LOCK_AFTER_SECONDS.map(seconds => ({
				value: String(seconds),
				label:
					seconds === 0
						? t("settingsDesktopLockAfterNever")
						: seconds < 3600
							? t("settingsDesktopLockAfterMinutes", { count: seconds / 60 })
							: t("settingsDesktopLockAfterHours", { count: seconds / 3600 })
			}))}
			value={value === undefined ? undefined : String(value)}
			disabled={saving}
			onChange={next => {
				const seconds = DESKTOP_LOCK_AFTER_SECONDS.find(choice => String(choice) === next)

				if (seconds === undefined) {
					return
				}

				setSaving(true)
				setDesktopPref({ lockAfterSeconds: seconds })
					.catch(() => {
						toast.error(t("settingsDesktopSaveFailed"))
					})
					.finally(() => {
						setSaving(false)
					})
			}}
		/>
	)
}

// Settings > Desktop: the app lock's PIN, lock-after and lock-now rows. A PIN stored with secure storage that this run lacks is
// kept for a run that has it, and main refuses a new one over it, so setting one waits too, and the row says why.
export function AppLockSettings() {
	const { t } = useTranslation("desktop")
	const lockEnabled = useDesktopLock(state => state.status?.enabled === true)
	const waiting = useDesktopLock(state => state.status?.waitingForSecureStorage === true)
	const [pinMode, setPinMode] = useState<PinDialogMode | null>(null)
	const bridge = desktopBridge()

	return (
		<>
			<SettingsGroup title={t("settingsLockTitle")}>
				<SettingsRow
					label={t("settingsLockPin")}
					description={t(waiting ? "settingsLockPinWaiting" : "settingsLockPinDescription")}
				>
					{lockEnabled ? (
						<>
							<Button
								type="button"
								variant="outline"
								aria-label={t("pinChangeTitle")}
								onClick={() => {
									setPinMode("change")
								}}
							>
								{t("settingsLockChange")}
							</Button>
							<Button
								type="button"
								variant="outline"
								aria-label={t("pinRemoveTitle")}
								onClick={() => {
									setPinMode("remove")
								}}
							>
								{t("settingsLockRemove")}
							</Button>
						</>
					) : (
						<Button
							type="button"
							variant="outline"
							disabled={waiting}
							onClick={() => {
								setPinMode("set")
							}}
						>
							{t("settingsLockSet")}
						</Button>
					)}
				</SettingsRow>
				{lockEnabled && !waiting ? <LockAfterRow /> : null}
				{lockEnabled ? (
					<SettingsRow
						label={t("settingsLockNow")}
						description={t("settingsLockNowDescription")}
					>
						<Button
							type="button"
							variant="outline"
							aria-label={t("settingsLockNow")}
							onClick={() => {
								bridge?.lock.lock()
							}}
						>
							{t("settingsLockNowAction")}
						</Button>
					</SettingsRow>
				) : null}
			</SettingsGroup>
			<PinDialog
				mode={pinMode}
				onClose={() => {
					setPinMode(null)
				}}
			/>
		</>
	)
}
