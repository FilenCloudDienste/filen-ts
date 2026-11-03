import { useState } from "react"
import { useTranslation } from "react-i18next"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { useDesktopLock } from "@/features/desktop/lib/lock"
import { PinDialog, type PinDialogMode } from "@/features/desktop/components/pinDialog"
import { Button } from "@/components/ui/button"
import { desktopBridge } from "@/lib/desktop"

// Settings > Desktop: the app lock's PIN and lock-now rows. A PIN stored with secure storage that this run lacks is
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
