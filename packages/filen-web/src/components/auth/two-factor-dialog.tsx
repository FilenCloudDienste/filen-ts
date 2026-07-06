import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface TwoFactorDialogProps {
	open: boolean
	pending: boolean
	// Set only for a rejected retry (`Wrong2fa`) — absent on the first, code-less open (`Enter2fa`).
	// Explicit `| undefined` (not just `?`) so the caller's `string | undefined` state passes through
	// directly under exactOptionalPropertyTypes, matching how DOM attribute types are declared.
	error?: string | undefined
	onOpenChange: (open: boolean) => void
	onSubmit: (code: string) => void
}

// Login two-factor step: an authenticator-code input plus a one-way toggle to a plain recovery-key
// input — the SDK accepts either value as `twoFactorCode` (same field, same retry call). shadcn's
// `input-otp` add resolves to the `input-otp` npm package (not a `@base-ui/react` primitive — Base
// UI's own `otp-field` isn't wired into the registry's base-rhea style yet), so per the documented
// fallback this is a plain numeric `Input`, not a boxed OTP widget. Closing by any means (Cancel/
// Escape/outside click) is silent — only a rejected retry surfaces an error, and only a non-2FA kind
// from a retry closes the dialog (that path lives in the caller, which owns the login attempt).
function TwoFactorDialog({ open, pending, error, onOpenChange, onSubmit }: TwoFactorDialogProps) {
	const { t } = useTranslation("auth")
	const [code, setCode] = useState("")
	const [recoveryKey, setRecoveryKey] = useState("")
	const [useRecoveryKey, setUseRecoveryKey] = useState(false)
	const value = useRecoveryKey ? recoveryKey : code

	function handleOpenChange(next: boolean): void {
		onOpenChange(next)
		if (!next) {
			setCode("")
			setRecoveryKey("")
			setUseRecoveryKey(false)
		}
	}

	function handleSubmit(e: SubmitEvent): void {
		e.preventDefault()
		onSubmit(value.trim())
		// Cleared unconditionally: a right code closes the dialog anyway; a wrong one must present an
		// empty field per the retry contract.
		setCode("")
		setRecoveryKey("")
	}

	return (
		<Dialog
			open={open}
			onOpenChange={handleOpenChange}
		>
			<DialogContent>
				<form
					onSubmit={handleSubmit}
					className="flex flex-col gap-6"
				>
					<DialogHeader>
						<DialogTitle>{t("twoFactorTitle")}</DialogTitle>
						<DialogDescription>{t("twoFactorBody")}</DialogDescription>
					</DialogHeader>
					<Field data-invalid={error !== undefined}>
						<FieldLabel htmlFor="two-factor-value">
							{useRecoveryKey ? t("twoFactorRecoveryKeyInput") : t("twoFactorCode")}
						</FieldLabel>
						<Input
							id="two-factor-value"
							value={value}
							autoFocus
							autoComplete="one-time-code"
							aria-invalid={error !== undefined}
							inputMode={useRecoveryKey ? undefined : "numeric"}
							maxLength={useRecoveryKey ? undefined : 6}
							onChange={e => {
								if (useRecoveryKey) {
									setRecoveryKey(e.target.value)
								} else {
									setCode(e.target.value)
								}
							}}
						/>
						{error !== undefined && <FieldError>{error}</FieldError>}
					</Field>
					{!useRecoveryKey && (
						<Button
							type="button"
							variant="link"
							className="h-auto self-start p-0 text-xs"
							onClick={() => {
								setUseRecoveryKey(true)
							}}
						>
							{t("twoFactorUseRecoveryKey")}
						</Button>
					)}
					<DialogFooter>
						<Button
							type="submit"
							disabled={pending || value.trim().length === 0}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{t("loginSubmit")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export { TwoFactorDialog }
