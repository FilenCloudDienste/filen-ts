import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PdfOwnerUnlockDialog } from "@/features/pdf/security/ownerUnlockDialog"

// The owner password prompt as a host shows it: `unlock` checks a typed password in the editor (true: it was the
// owner password, false: it was not, null: the editor could not check it).
export function useOwnerUnlock(unlock: (password: string) => Promise<boolean | null>): {
	readonly open: () => void
	readonly dialog: ReactNode
} {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)
	const [wrong, setWrong] = useState(false)

	return {
		open: () => {
			setWrong(false)
			setOpen(true)
		},
		dialog: (
			<PdfOwnerUnlockDialog
				open={open}
				pending={pending}
				wrong={wrong}
				onOpenChange={next => {
					if (!pending) setOpen(next)
				}}
				onUnlock={password => {
					setPending(true)
					void unlock(password).then(result => {
						setPending(false)

						if (result === true) {
							setOpen(false)
							toast.success(t("previewPdfSecurityUnlocked"))
						} else if (result === false) setWrong(true)
						else toast.error(t("previewPdfChangeFailed"))
					})
				}}
			/>
		)
	}
}
