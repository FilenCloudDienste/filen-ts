import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { Button } from "@/components/ui/button"

export interface EmptyTrashButtonProps {
	onClick: () => void
	disabled?: boolean
	// Set only when `disabled` is caused specifically by the app being offline — surfaced as the
	// button's native title so a click-that-does-nothing has a reason attached, distinct from any
	// other future disable cause this button might grow.
	offlineTitle?: string | undefined
}

// Trash toolbar's own trigger — directoryListing.tsx only mounts this once
// isEmptyTrashTriggerVisible(variant, sortedItems.length) is true (trash variant, non-empty
// listing). Opens the already-wired TypedConfirmDialog (useDriveDialogHost's "emptyTrash" arm);
// this component owns no dialog state of its own.
export function EmptyTrashButton({ onClick, disabled, offlineTitle }: EmptyTrashButtonProps) {
	const { t } = useTranslation("drive")
	const { labelKey, icon } = ACTION_DEFS.emptyTrash

	return (
		<Button
			variant="destructive"
			size="sm"
			disabled={disabled}
			title={offlineTitle}
			onClick={onClick}
		>
			{createElement(icon, { "aria-hidden": true })}
			{t(labelKey)}
		</Button>
	)
}
