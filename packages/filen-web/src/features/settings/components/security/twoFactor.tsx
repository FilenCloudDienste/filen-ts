import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import QRCode from "react-qr-code"
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { copyText } from "@/lib/copyText"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import { accountQueryUpdate, type AccountQuerySuccess } from "@/queries/account"
import { buildOtpauthUri } from "@/features/settings/components/security/twoFactor.logic"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { holdUnload } from "@/lib/unloadGuard"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface TwoFactorRowProps {
	accountQuery: AccountQuerySuccess
}

// Module scope, not an inline arrow: useBlocker's registration effect lists shouldBlockFn in its deps.
const blockEveryNavigation: ShouldBlockFn = () => true

interface RecoveryKeyPanelProps {
	recoveryKey: string
	onClose: () => void
}

// The 2FA recovery key (the account's ONE-TIME backup code — distinct from the exportMasterKeys
// artifact, see the naming law in locales/en/auth.ts) is shown here exactly once, straight from
// enable2FA's return value, and lives ONLY in this component's state — it is never persisted,
// logged, or refetched. It can only be dismissed via the explicit "I've saved it" confirm; every
// other dismissal route is blocked (pendingGuardedOpenChange with `!saved` as pending) so a stray
// Escape or outside-click can never lose it before the user has acknowledged saving it. Navigation is
// held the same way: a Back gesture or a closing tab would unmount it just as surely.
function RecoveryKeyPanel({ recoveryKey, onClose }: RecoveryKeyPanelProps) {
	const { t } = useTranslation("auth")
	const [saved, setSaved] = useState(false)

	useBlocker({ shouldBlockFn: blockEveryNavigation, enableBeforeUnload: false, withResolver: false })
	useEffect(() => holdUnload(), [])

	const handleOpenChange = pendingGuardedOpenChange(!saved, next => {
		if (!next) {
			onClose()
		}
	})

	async function handleCopy(): Promise<void> {
		await copyText(recoveryKey, t("copiedToClipboard"))
	}

	function handleDownload(): void {
		downloadTextFile(`recovery-key.${String(Date.now())}.txt`, recoveryKey)
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent closeButtonDisabled={!saved}>
				<DialogHeader>
					<DialogTitle>{t("recoveryKeyTitle")}</DialogTitle>
					<DialogDescription>{t("recoveryKeyBody")}</DialogDescription>
				</DialogHeader>
				<div className="rounded-2xl bg-muted p-4 font-mono text-sm break-all select-all">{recoveryKey}</div>
				{/* Single wrapper child so DialogFooter's own flex-col-reverse/sm:flex-row defaults
				(built for a plain cancel+confirm pair) never fight this panel's 3-button stack — the
				actual button order is owned entirely by this inner div. */}
				<DialogFooter>
					<div className="flex w-full flex-col gap-2">
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								className="flex-1"
								onClick={() => {
									void handleCopy()
								}}
							>
								{t("recoveryKeyCopy")}
							</Button>
							<Button
								type="button"
								variant="outline"
								className="flex-1"
								onClick={handleDownload}
							>
								{t("recoveryKeyDownload")}
							</Button>
						</div>
						<Button
							type="button"
							className="w-full"
							onClick={() => {
								setSaved(true)
								onClose()
							}}
						>
							{t("recoveryKeySavedConfirm")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// Row state comes straight from useAccountQuery: `twoFactorEnabled` picks the enable/disable
// branch, `twoFactorKey` (string | undefined — undefined once enabled, or transiently before the
// server has issued one) gates whether the setup step can open at all. Enable is setup dialog (QR +
// secret) → code prompt → one-time recovery key; each step closes before the next opens, so no
// dialog is ever stacked on another. Disable is the destructive path: a confirm, then a code prompt;
// enable has no destructive confirm (turning security ON needs no "are you sure").
function TwoFactorRow({ accountQuery }: TwoFactorRowProps) {
	const { t } = useTranslation(["auth", "settings", "common"])
	const isOnline = useIsOnline()
	const { email, twoFactorEnabled, twoFactorKey } = accountQuery.data
	const setupAvailable = twoFactorKey !== undefined && twoFactorKey.length > 0

	const [setupOpen, setSetupOpen] = useState(false)
	const [enableCodeOpen, setEnableCodeOpen] = useState(false)
	const [enablePending, setEnablePending] = useState(false)
	const [recoveryKey, setRecoveryKey] = useState<string | null>(null)

	const [disableConfirmOpen, setDisableConfirmOpen] = useState(false)
	const [disableCodeOpen, setDisableCodeOpen] = useState(false)
	const [disablePending, setDisablePending] = useState(false)

	async function handleCopySecret(): Promise<void> {
		if (twoFactorKey === undefined) {
			return
		}
		await copyText(twoFactorKey, t("copiedToClipboard"))
	}

	async function handleEnableSubmit(code: string): Promise<void> {
		setEnablePending(true)
		try {
			const key = await sdkApi.enable2FA(code)
			setEnableCodeOpen(false)
			setRecoveryKey(key)
			// A patch, not a read: a failed read would put the page in its error state and unmount the
			// only copy of the key. getUserInfo withholds the setup key while 2FA is on; mirror that.
			accountQueryUpdate(prev => ({ ...prev, twoFactorEnabled: true, twoFactorKey: undefined }))
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			setEnablePending(false)
		}
	}

	async function handleDisableSubmit(code: string): Promise<void> {
		setDisablePending(true)
		try {
			await sdkApi.disable2FA(code)
			setDisableCodeOpen(false)
			void accountQuery.refetch()
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			setDisablePending(false)
		}
	}

	return (
		<SettingsRow
			label={t("twoFactorSectionTitle")}
			description={t("twoFactorSectionDescription")}
		>
			<span className="text-sm text-muted-foreground">
				{twoFactorEnabled ? t("settings:settingsTwoFactorOn") : t("settings:settingsTwoFactorOff")}
			</span>
			{twoFactorEnabled ? (
				<Button
					type="button"
					variant="destructive"
					disabled={!isOnline}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
					onClick={() => {
						setDisableConfirmOpen(true)
					}}
				>
					{t("twoFactorDisableSubmit")}
				</Button>
			) : (
				<Button
					type="button"
					variant="outline"
					disabled={!setupAvailable || !isOnline}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
					onClick={() => {
						setSetupOpen(true)
					}}
				>
					{t("settings:settingsTwoFactorSetUpAction")}
				</Button>
			)}

			{setupAvailable && (
				<Dialog
					open={setupOpen}
					onOpenChange={setSetupOpen}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t("twoFactorSectionTitle")}</DialogTitle>
							<DialogDescription>{t("settings:settingsTwoFactorSetUpDescription")}</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col items-center gap-4">
							<div className="rounded-3xl bg-white p-4">
								<QRCode
									value={buildOtpauthUri(email, twoFactorKey)}
									size={192}
								/>
							</div>
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									void handleCopySecret()
								}}
							>
								{t("twoFactorCopySecret")}
							</Button>
						</div>
						<DialogFooter>
							<Button
								type="button"
								disabled={!isOnline}
								title={!isOnline ? t("common:offlineActionDisabled") : undefined}
								onClick={() => {
									setSetupOpen(false)
									setEnableCodeOpen(true)
								}}
							>
								{t("settings:settingsTwoFactorContinue")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}

			<InputDialog
				open={enableCodeOpen}
				pending={enablePending}
				title={t("twoFactorEnterCodeTitle")}
				body={t("twoFactorEnterCodeBody")}
				label={t("twoFactorCode")}
				inputMode="numeric"
				autoComplete="one-time-code"
				maxLength={6}
				submitLabel={t("twoFactorEnableSubmit")}
				validate={value => value.trim().length > 0}
				onOpenChange={setEnableCodeOpen}
				onSubmit={code => {
					void handleEnableSubmit(code)
				}}
			/>

			<ConfirmDialog
				open={disableConfirmOpen}
				pending={false}
				title={t("twoFactorDisableTitle")}
				body={t("twoFactorDisableBody")}
				confirmLabel={t("twoFactorDisableSubmit")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={setDisableConfirmOpen}
				onConfirm={() => {
					setDisableConfirmOpen(false)
					setDisableCodeOpen(true)
				}}
			/>
			<InputDialog
				open={disableCodeOpen}
				pending={disablePending}
				title={t("twoFactorEnterCodeTitle")}
				body={t("twoFactorEnterCodeBody")}
				label={t("twoFactorCode")}
				inputMode="numeric"
				autoComplete="one-time-code"
				maxLength={6}
				submitLabel={t("twoFactorDisableSubmit")}
				validate={value => value.trim().length > 0}
				onOpenChange={setDisableCodeOpen}
				onSubmit={code => {
					void handleDisableSubmit(code)
				}}
			/>

			{recoveryKey !== null && (
				<RecoveryKeyPanel
					recoveryKey={recoveryKey}
					onClose={() => {
						setRecoveryKey(null)
					}}
				/>
			)}
		</SettingsRow>
	)
}

export { TwoFactorRow }
