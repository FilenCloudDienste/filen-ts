import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SecretInput } from "@/components/ui/secretInput"

export interface PdfOwnerUnlockDialogProps {
	open: boolean
	// The caller is checking a password in the engine.
	pending: boolean
	// The last password checked was not the owner password.
	wrong: boolean
	onOpenChange: (open: boolean) => void
	// The typed password; the caller authenticates it in the engine (unlockOwner) and closes on success.
	onUnlock: (password: string) => void
}

// Asks for a PDF's owner password, which lifts the restrictions its author set. The password stays in memory with
// the session and is never stored; the field never triggers a password manager. Each opening starts empty.
export function PdfOwnerUnlockDialog({ open, pending, wrong, onOpenChange, onUnlock }: PdfOwnerUnlockDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [password, setPassword] = useState("")
	const [seenOpen, setSeenOpen] = useState(open)

	if (seenOpen !== open) {
		setSeenOpen(open)

		if (open) setPassword("")
	}

	return (
		<FormDialog
			open={open}
			pending={pending}
			title={t("previewPdfSecurityUnlockTitle")}
			description={t("previewPdfSecurityUnlockBody")}
			submitLabel={t("previewPdfSecurityUnlockAction")}
			cancelLabel={t("common:cancel")}
			canSubmit={password !== ""}
			onOpenChange={onOpenChange}
			onSubmit={event => {
				event.preventDefault()

				if (pending || password === "") return

				onUnlock(password)
			}}
		>
			<FieldGroup>
				<Field data-invalid={wrong ? true : undefined}>
					<FieldLabel htmlFor={`${id}-password`}>{t("previewPdfSecurityUnlockLabel")}</FieldLabel>
					<SecretInput
						id={`${id}-password`}
						value={password}
						disabled={pending}
						aria-invalid={wrong}
						autoFocus
						onChange={event => {
							setPassword(event.target.value)
						}}
					/>
					{wrong ? <FieldError>{t("previewPdfSecurityUnlockWrong")}</FieldError> : null}
				</Field>
			</FieldGroup>
		</FormDialog>
	)
}
