import { useTranslation } from "react-i18next"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

export interface SignatureInvalidationDialogProps {
	open: boolean
	// Signatures the save would invalidate.
	count: number
	pending: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
}

// Asked before a save that invalidates digital signatures (a full rewrite of a signed document). Destructive: Cancel
// has the focus, so a blind Enter never breaks signatures.
export function SignatureInvalidationDialog({ open, count, pending, onOpenChange, onConfirm }: SignatureInvalidationDialogProps) {
	const { t } = useTranslation(["preview", "common"])

	return (
		<ConfirmDialog
			open={open}
			pending={pending}
			destructive
			title={t("previewPdfSigningInvalidateTitle")}
			body={t("previewPdfSigningInvalidate", { count })}
			confirmLabel={t("previewPdfSigningInvalidateConfirm")}
			cancelLabel={t("common:cancel")}
			onOpenChange={onOpenChange}
			onConfirm={onConfirm}
		/>
	)
}
