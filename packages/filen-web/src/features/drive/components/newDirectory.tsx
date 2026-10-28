import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runCreateDirectory } from "@/features/drive/lib/createDirectory"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { InputDialog } from "@/components/dialogs/inputDialog"

export interface NewDirectoryDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	// The directory the new one is created in, null for My Drive's root.
	parentUuid: string | null
	hiddenNotice: boolean
}

// The name dialog behind New directory — the toolbar's New menu, the move dialog and the tree's menus.
export function NewDirectoryDialog({ open, onOpenChange, parentUuid, hiddenNotice }: NewDirectoryDialogProps) {
	const { t } = useTranslation("drive")
	const [pending, setPending] = useState(false)

	async function handleSubmit(name: string): Promise<void> {
		setPending(true)

		const trimmed = name.trim()
		const outcome = await runCreateDirectory(
			{ createDirectory: (parent, next) => sdkApi.createDirectory(parent, next), patchListing: driveListingQueryUpdate },
			parentUuid,
			trimmed
		)

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
			open={open}
			pending={pending}
			title={t("driveNewDirectoryTitle")}
			body={t("driveNewDirectoryBody")}
			label={t("driveNewDirectoryLabel")}
			placeholder={t("driveNewDirectoryPlaceholder")}
			submitLabel={t("driveNewDirectorySubmit")}
			validate={name => name.trim().length > 0}
			onOpenChange={onOpenChange}
			onSubmit={value => {
				void handleSubmit(value)
			}}
		/>
	)
}
