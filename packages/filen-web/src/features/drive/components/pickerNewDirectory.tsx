import { isImeKeydown } from "@filen/shared/keymap"
import { useId } from "react"
import { useTranslation } from "react-i18next"
import { FolderPlusIcon } from "lucide-react"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { PICKER_LIST_PADDING, PICKER_ROW_HEIGHT } from "@/features/drive/components/directoryPicker"
import { ITEM_NAME_ERROR_KEYS } from "@/features/drive/lib/archiveTargets"
import type { PickerNewDirectoryDraft, PickerNewDirectoryError } from "@/features/drive/lib/pickerNewDirectory.logic"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

// The pinned name row: the list's top padding and one picker row; a line below it while it shows an error.
export const PICKER_NEW_DIRECTORY_HEIGHT = PICKER_LIST_PADDING + PICKER_ROW_HEIGHT
export const PICKER_NEW_DIRECTORY_ERROR_HEIGHT = 20

export function PickerNewDirectoryButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
	const { t } = useTranslation("drive")

	return (
		<Button
			type="button"
			variant="outline"
			disabled={disabled}
			className="sm:mr-auto"
			onClick={onClick}
		>
			<FolderPlusIcon />
			{t("driveMoveDialogNewDirectory")}
		</Button>
	)
}

export interface PickerNewDirectoryRowProps {
	draft: PickerNewDirectoryDraft
	onChange: (name: string) => void
	onSubmit: () => void
	onCancel: () => void
	onBlur: () => void
}

export function PickerNewDirectoryRow({ draft, onChange, onSubmit, onCancel, onBlur }: PickerNewDirectoryRowProps) {
	const { t } = useTranslation(["archive", "drive"])
	const errorId = useId()

	function errorMessage(error: PickerNewDirectoryError): string {
		switch (error.kind) {
			case "empty":
				return t("archiveName_Empty")
			case "taken":
				return t("drive:driveNewFileNameTaken")
			case "name":
				return t(ITEM_NAME_ERROR_KEYS[error.reason])
			case "failed":
				return error.message
		}
	}

	const message = draft.error === null ? null : errorMessage(draft.error)

	return (
		<>
			<div className="flex h-9 items-center gap-2 rounded-xl bg-accent/60 px-3">
				<DirectoryGlyph
					color="default"
					className="size-4 shrink-0"
				/>
				<Input
					autoFocus
					autoComplete="off"
					value={draft.name}
					// Kept focused while it creates: a disabled field would drop focus out of the dialog.
					readOnly={draft.pending}
					aria-label={t("drive:drivePickerNewDirectoryName")}
					aria-invalid={message === null ? undefined : true}
					aria-describedby={message === null ? undefined : errorId}
					placeholder={t("drive:driveNewDirectoryPlaceholder")}
					className="h-7 min-w-0 flex-1 px-2 leading-5"
					onChange={event => {
						if (!draft.pending) {
							onChange(event.target.value)
						}
					}}
					onKeyDown={event => {
						if (event.key === "Enter" && !isImeKeydown(event.nativeEvent)) {
							event.preventDefault()
							event.stopPropagation()
							onSubmit()
						} else if (event.key === "Escape") {
							// Never also the dialog's own Escape.
							event.preventDefault()
							event.stopPropagation()

							if (!draft.pending) {
								onCancel()
							}
						}
					}}
					onBlur={onBlur}
				/>
				{draft.pending ? <Spinner className="shrink-0 text-muted-foreground" /> : null}
			</div>
			{message === null ? null : (
				<p
					id={errorId}
					role="alert"
					title={message}
					className="h-5 truncate px-3 text-xs leading-5 text-destructive"
				>
					{message}
				</p>
			)}
		</>
	)
}
