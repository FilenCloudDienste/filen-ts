import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { TypedConfirmDialog } from "@/components/dialogs/typedConfirmDialog"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface TypedDeleteRowProps {
	title: string
	description: string
	submitLabel: string
	confirmBody: string
	phrase: string
	successMessage: string
	run: () => Promise<void>
	onDeleted: () => void
}

// A destructive account-wide wipe behind a TypedConfirmDialog, the same primitive drive's
// emptyTrashButton uses: its exact-match gate is what keeps the button disabled on a wrong phrase.
function TypedDeleteRow({ title, description, submitLabel, confirmBody, phrase, successMessage, run, onDeleted }: TypedDeleteRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)

	async function handleConfirm(): Promise<void> {
		setPending(true)
		try {
			await run()
			setOpen(false)
			toast.success(successMessage)
			onDeleted()
		} catch (e) {
			toast.error(errorLabel(e))
		}
		// After the catch rather than in a finally, which the React Compiler cannot lower.
		setPending(false)
	}

	return (
		<SettingsRow
			label={title}
			description={description}
			destructive
		>
			<Button
				type="button"
				variant="destructive"
				disabled={!isOnline}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onClick={() => {
					setOpen(true)
				}}
			>
				{submitLabel}
			</Button>

			<TypedConfirmDialog
				open={open}
				pending={pending}
				title={title}
				body={confirmBody}
				matchLabel={t("common:confirmationPhrase")}
				matchValue={phrase}
				confirmLabel={submitLabel}
				cancelLabel={t("common:cancel")}
				onOpenChange={next => {
					if (!next) {
						setOpen(false)
					}
				}}
				onConfirm={() => {
					void handleConfirm()
				}}
			/>
		</SettingsRow>
	)
}

export { TypedDeleteRow }
