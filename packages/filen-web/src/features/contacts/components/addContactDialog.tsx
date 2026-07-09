import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { UserPlusIcon } from "lucide-react"
import { isValidEmail } from "@/lib/validate"
import { sendContactRequest } from "@/features/contacts/lib/actions"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { InputDialog } from "@/components/dialogs/input-dialog"

// Self-contained trigger + dialog, mirroring drive/new-directory.tsx's shape exactly (a toolbar-level
// action with no per-item target, so it owns its own open/pending state rather than routing through
// contacts-list.tsx's per-row confirm-dialog host). The dialog itself IS the confirm — sending a
// request needs no separate ConfirmDialog, matching every other "type a value, submit" flow.
export function AddContactDialog() {
	const { t } = useTranslation("contacts")
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)

	async function handleSubmit(email: string): Promise<void> {
		setPending(true)
		const outcome = await sendContactRequest(email.trim())
		setPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. no account for that address) so the user can fix the
			// email and retry — mirrors new-directory.tsx's identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		setOpen(false)
	}

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				onClick={() => {
					setOpen(true)
				}}
			>
				<UserPlusIcon aria-hidden="true" />
				{t("contactsActionAdd")}
			</Button>
			<InputDialog
				open={open}
				pending={pending}
				title={t("contactsActionAdd")}
				body={t("contactsAddBody")}
				label={t("contactsAddEmailLabel")}
				placeholder={t("contactsAddEmailPlaceholder")}
				type="email"
				submitLabel={t("contactsActionAdd")}
				validate={isValidEmail}
				onOpenChange={setOpen}
				onSubmit={value => {
					void handleSubmit(value)
				}}
			/>
		</>
	)
}
