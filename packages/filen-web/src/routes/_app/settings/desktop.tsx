import { useEffect, useState } from "react"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { MonitorIcon } from "lucide-react"
import type { DesktopPrefs } from "@filen/shared/desktop"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"
import { SettingsGroup, SettingsPage, SettingsRow } from "@/features/settings/components/settingsLayout"
import { loadDesktopPrefs, setDesktopPref, useDesktopPrefs } from "@/features/desktop/lib/prefs"
import { useDesktopLock } from "@/features/desktop/lib/lock"
import { PinDialog, type PinDialogMode } from "@/features/desktop/components/pinDialog"
import { formatLogEntries } from "@/features/settings/lib/logs"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// The desktop app's own prefs, kept by the shell (D15). A browser has none, so the section does not exist there.
export const Route = createFileRoute("/_app/settings/desktop")({
	beforeLoad: () => {
		if (desktopBridge() === undefined) {
			throw redirect({ to: "/settings/account" })
		}
	},
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionDesktop"), i18n.t("common:settings")] }),
	component: DesktopPage
})

type PrefKey = keyof DesktopPrefs

function DesktopPage() {
	const { t } = useTranslation(["settings", "desktop"])
	const prefs = useDesktopPrefs(state => state.prefs)
	const lockEnabled = useDesktopLock(state => state.status?.enabled === true)
	const [pending, setPending] = useState<PrefKey | null>(null)
	const [pinMode, setPinMode] = useState<PinDialogMode | null>(null)
	const [exporting, setExporting] = useState(false)
	const bridge = desktopBridge()

	function exportLogs(): void {
		if (bridge === undefined) {
			return
		}

		setExporting(true)
		// This page's own ring buffer; main adds its log, redacts both and asks where to save.
		bridge.logs
			.export(formatLogEntries(log.dump()))
			.then(outcome => {
				if (outcome === "saved") {
					toast.success(t("desktop:logsExported"))
				}
			})
			.catch((error: unknown) => {
				log.error("desktop", "logs export failed", error)
				toast.error(t("desktop:logsExportFailed"))
			})
			.finally(() => {
				setExporting(false)
			})
	}

	useEffect(() => {
		void loadDesktopPrefs()
	}, [])

	function toggleRow(key: PrefKey, title: string, description: string) {
		return (
			<PreferenceToggleRow
				title={title}
				description={description}
				checked={prefs?.[key] ?? false}
				disabled={prefs === null || pending === key}
				onCheckedChange={checked => {
					setPending(key)
					setDesktopPref({ [key]: checked })
						.catch(() => {
							toast.error(t("settingsDesktopSaveFailed"))
						})
						.finally(() => {
							setPending(null)
						})
				}}
			/>
		)
	}

	return (
		<SettingsPage
			icon={MonitorIcon}
			title={t("settingsSectionDesktop")}
		>
			<SettingsGroup title={t("settingsDesktopStartupTitle")}>
				{/* Login items on macOS and Windows, an XDG autostart entry on Linux: every desktop OS has one. */}
				{toggleRow("launchAtLogin", t("settingsDesktopLaunchAtLogin"), t("settingsDesktopLaunchAtLoginDescription"))}
				{toggleRow("startMinimized", t("settingsDesktopStartMinimized"), t("settingsDesktopStartMinimizedDescription"))}
			</SettingsGroup>
			{/* macOS always keeps the app running when its window closes (the dock reopens it). */}
			{bridge?.platform === "darwin" ? null : (
				<SettingsGroup title={t("settingsDesktopWindowTitle")}>
					{toggleRow("minimizeToTray", t("settingsDesktopMinimizeToTray"), t("settingsDesktopMinimizeToTrayDescription"))}
				</SettingsGroup>
			)}
			<SettingsGroup title={t("settingsDesktopNotificationsTitle")}>
				{toggleRow("notifications", t("settingsDesktopNotifications"), t("settingsDesktopNotificationsDescription"))}
			</SettingsGroup>
			<SettingsGroup title={t("desktop:settingsLockTitle")}>
				<SettingsRow
					label={t("desktop:settingsLockPin")}
					description={t("desktop:settingsLockPinDescription")}
				>
					{lockEnabled ? (
						<>
							<Button
								type="button"
								variant="outline"
								aria-label={t("desktop:pinChangeTitle")}
								onClick={() => {
									setPinMode("change")
								}}
							>
								{t("desktop:settingsLockChange")}
							</Button>
							<Button
								type="button"
								variant="outline"
								aria-label={t("desktop:pinRemoveTitle")}
								onClick={() => {
									setPinMode("remove")
								}}
							>
								{t("desktop:settingsLockRemove")}
							</Button>
						</>
					) : (
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								setPinMode("set")
							}}
						>
							{t("desktop:settingsLockSet")}
						</Button>
					)}
				</SettingsRow>
				{lockEnabled ? (
					<SettingsRow
						label={t("desktop:settingsLockNow")}
						description={t("desktop:settingsLockNowDescription")}
					>
						<Button
							type="button"
							variant="outline"
							aria-label={t("desktop:settingsLockNow")}
							onClick={() => {
								bridge?.lock.lock()
							}}
						>
							{t("desktop:settingsLockNowAction")}
						</Button>
					</SettingsRow>
				) : null}
			</SettingsGroup>
			<SettingsGroup title={t("desktop:settingsLogsTitle")}>
				<SettingsRow
					label={t("desktop:settingsLogsExport")}
					description={t("desktop:settingsLogsExportDescription")}
				>
					<Button
						type="button"
						variant="outline"
						aria-label={t("desktop:settingsLogsExport")}
						disabled={exporting}
						onClick={exportLogs}
					>
						{exporting && <Spinner data-icon="inline-start" />}
						{t("desktop:settingsLogsExportAction")}
					</Button>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title={t("settingsAboutTitle")}>
				<SettingsRow label={t("settingsDesktopVersion")}>
					<span className="text-sm text-muted-foreground tabular-nums">{bridge?.app.version}</span>
				</SettingsRow>
			</SettingsGroup>
			<PinDialog
				mode={pinMode}
				onClose={() => {
					setPinMode(null)
				}}
			/>
		</SettingsPage>
	)
}
