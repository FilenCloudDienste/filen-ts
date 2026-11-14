import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { usePdfEditSession } from "@filen/office/react/pdfedit"
import { PdfProtectDialog } from "@/features/pdf/security/protectDialog"
import { chooseProtection, refusalKey, unlockOwnerRights } from "@/features/pdf/security/protectSession"
import { useOwnerUnlock } from "@/features/pdf/security/useOwnerUnlock"
import { useToolSession } from "@/features/pdf/session/useToolSession"
import { withPdfSession, type PdfToolPanelProps } from "@/features/pdf/tools/registry"

// Protect › Protect document (and Save ▾ Security…): the Protect document dialog over the editor's document. The
// choice is planned in the editor and written by the next save; closing the dialog ends the tool.
export function ProtectPanel({ context }: PdfToolPanelProps) {
	const { t } = useTranslation("preview")
	const { session } = useToolSession(context)
	const snapshot = usePdfEditSession(session)
	const [pending, setPending] = useState(false)
	const unlock = useOwnerUnlock(async password => {
		const unlocked = await withPdfSession(context, current => unlockOwnerRights(current, password)).catch(() => null)

		if (unlocked === true) context.host.unlocked(password)

		return unlocked
	})

	if (snapshot === null) return null

	return (
		<>
			<PdfProtectDialog
				open
				pending={pending}
				current={snapshot.state.security}
				onOpenChange={open => {
					if (!open) context.finish()
				}}
				onApply={choice => {
					setPending(true)
					void withPdfSession(context, current => chooseProtection(current, choice)).then(
						refusal => {
							setPending(false)

							if (refusal !== null) toast.error(t(refusalKey(refusal)))
							else {
								toast.info(t("previewPdfSecurityApplied"))
								context.finish()
							}
						},
						() => {
							setPending(false)
							toast.error(t("previewPdfSecurityFailed"))
						}
					)
				}}
				onUnlock={unlock.open}
			/>
			{unlock.dialog}
		</>
	)
}
