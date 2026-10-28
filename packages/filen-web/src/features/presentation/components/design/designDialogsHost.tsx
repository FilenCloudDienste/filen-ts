import { useEffect } from "react"
import { BackgroundDialog } from "@/features/presentation/components/design/backgroundDialog"
import { closeDesignDialog, registerDesignHost, useDesignDialog } from "@/features/presentation/components/design/designDialogs"
import { SlideSizeDialog } from "@/features/presentation/components/design/slideSizeDialog"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"

// The Design tab's dialogs beside the editor (mounted inside its PresentationEditorContext), so a dialog asked for from
// an overflow menu outlives the menu.
export function DesignDialogsHost() {
	const store = usePresentationEditor()?.editor.store
	const dialog = useDesignDialog(store)

	useEffect(() => (store === undefined ? undefined : registerDesignHost(store)), [store])

	return <DesignDialogView dialog={dialog} />
}

export function DesignDialogView({ dialog }: { dialog: ReturnType<typeof useDesignDialog> }) {
	const store = usePresentationEditor()?.editor.store
	const close = (open: boolean): void => {
		if (!open && store !== undefined) closeDesignDialog(store)
	}

	if (dialog === undefined) return null

	return dialog.kind === "size" ? (
		<SlideSizeDialog
			key={dialog.key}
			open
			initial={dialog.initial}
			onOpenChange={close}
		/>
	) : (
		<BackgroundDialog
			key={dialog.key}
			open
			onOpenChange={close}
		/>
	)
}
