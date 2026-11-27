import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { createDirectory } from "@/features/drive/lib/actions"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { useNameFieldCheck } from "@/features/drive/hooks/useNameFieldCheck"

export interface NewDirectoryDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	// The directory the new one is created in, null for My Drive's root.
	parentUuid: string | null
	hiddenNotice: boolean
}

// The name dialog behind New directory — the toolbar's New menu, the move dialog and the tree's menus. Mounted only
// while open, so a closed one (every New menu holds one) observes no listing.
export function NewDirectoryDialog(props: NewDirectoryDialogProps) {
	return props.open ? <NewDirectoryPrompt {...props} /> : null
}

function NewDirectoryPrompt({ onOpenChange, parentUuid, hiddenNotice }: NewDirectoryDialogProps) {
	const { t } = useTranslation("drive")
	const [pending, setPending] = useState(false)
	const [value, setValue] = useState("")
	const check = useNameFieldCheck({ parentUuid, name: value })

	async function handleSubmit(name: string): Promise<void> {
		setPending(true)

		const trimmed = name.trim()
		const outcome = await createDirectory(parentUuid, trimmed)

		setPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash with a file) so the user can fix the name
			// and retry — mirrors every other write flow's toast.error(errorLabel(...)) convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		onOpenChange(false)
		// Creating has no success feedback of its own — the row appearing IS the feedback — so a name
		// the display filter will swallow needs to say so.
		notifyIfNameIsHidden(trimmed, "created", hiddenNotice)
	}

	return (
		<InputDialog
			open
			pending={pending}
			title={t("driveNewDirectoryTitle")}
			body={t("driveNewDirectoryBody")}
			label={t("driveNewDirectoryLabel")}
			placeholder={t("driveNewDirectoryPlaceholder")}
			submitLabel={t("driveNewDirectorySubmit")}
			validate={name => name.trim().length > 0 && !check.blocked(name)}
			errorFor={() => check.error}
			onValueChange={setValue}
			onOpenChange={onOpenChange}
			onSubmit={next => {
				void handleSubmit(next)
			}}
		/>
	)
}
