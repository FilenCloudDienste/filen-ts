import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import QRCode from "react-qr-code"
import { type DialogRoot } from "@base-ui/react/dialog"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import type { AccountQuerySuccess } from "@/queries/account"
import { buildOtpauthUri, canDismissRecoveryKeyPanel } from "@/features/settings/components/security/twoFactor.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"

interface TwoFactorCardProps {
	accountQuery: AccountQuerySuccess
}

interface RecoveryKeyPanelProps {
	recoveryKey: string
	onClose: () => void
}

// The 2FA recovery key (the account's ONE-TIME backup code — distinct from the exportMasterKeys
// artifact, see the naming law in locales/en/auth.ts) is shown here exactly once, straight from
// enable2FA's return value, and lives ONLY in this component's state — it is never persisted,
// logged, or refetched. It can only be dismissed via the explicit "I've saved it" confirm; every
// other dismissal route is blocked (canDismissRecoveryKeyPanel, twoFactor.logic.ts) so a stray
// Escape or outside-click can never lose it before the user has acknowledged saving it.
function RecoveryKeyPanel({ recoveryKey, onClose }: RecoveryKeyPanelProps) {
	const { t } = useTranslation("auth")
	const [saved, setSaved] = useState(false)

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!canDismissRecoveryKeyPanel(next, saved)) {
			details.cancel()
			return
		}
		if (!next) {
			onClose()
		}
	}

	async function handleCopy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(recoveryKey)
			toast.success(t("copiedToClipboard"))
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		}
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

// Card state comes straight from useAccountQuery: `twoFactorEnabled` picks the enable/disable
// branch, `twoFactorKey` (string | undefined — undefined once enabled, or transiently before the
// server has issued one) gates whether the QR/secret step can render at all. Disable is the
// destructive path: a confirm, then a code prompt; enable has no destructive confirm (turning
// security ON needs no "are you sure").
function TwoFactorCard({ accountQuery }: TwoFactorCardProps) {
	const { t } = useTranslation(["auth", "common"])
	const isOnline = useIsOnline()
	const { email, twoFactorEnabled, twoFactorKey } = accountQuery.data

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
		try {
			await navigator.clipboard.writeText(twoFactorKey)
			toast.success(t("copiedToClipboard"))
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		}
	}

	async function handleEnableSubmit(code: string): Promise<void> {
		setEnablePending(true)
		try {
			const key = await sdkApi.enable2FA(code)
			setEnableCodeOpen(false)
			setRecoveryKey(key)
			void accountQuery.refetch()
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
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
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setDisablePending(false)
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("twoFactorSectionTitle")}</CardTitle>
				<CardDescription>{t("twoFactorSectionDescription")}</CardDescription>
			</CardHeader>
			{!twoFactorEnabled && twoFactorKey !== undefined && twoFactorKey.length > 0 && (
				<CardContent>
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
				</CardContent>
			)}
			<CardFooter>
				{twoFactorEnabled ? (
					<Button
						type="button"
						variant="destructive"
						disabled={!isOnline}
						onClick={() => {
							setDisableConfirmOpen(true)
						}}
					>
						{t("twoFactorDisableSubmit")}
					</Button>
				) : (
					<Button
						type="button"
						disabled={twoFactorKey === undefined || twoFactorKey.length === 0 || !isOnline}
						onClick={() => {
							setEnableCodeOpen(true)
						}}
					>
						{t("twoFactorEnableSubmit")}
					</Button>
				)}
			</CardFooter>

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
		</Card>
	)
}

export { TwoFactorCard }
