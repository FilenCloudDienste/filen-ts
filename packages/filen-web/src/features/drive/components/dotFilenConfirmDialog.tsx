import { useState } from "react"
import { useTranslation } from "react-i18next"
import { DOT_FILEN_DIR_NAME } from "@filen/shared"
import { TypedConfirmDialog } from "@/components/dialogs/typedConfirmDialog"
import { useDotFilenAsk, type DotFilenOperation } from "@/features/drive/lib/dotFilenGuard"

const TITLE_KEYS = {
	trash: "driveDotFilenTrashTitle",
	delete: "driveDotFilenDeleteTitle",
	move: "driveDotFilenMoveTitle",
	rename: "driveDotFilenRenameTitle"
} as const

const CONFIRM_KEYS = {
	trash: "driveDotFilenTrashConfirm",
	delete: "driveDotFilenDeleteConfirm",
	move: "driveDotFilenMoveConfirm",
	rename: "driveDotFilenRenameConfirm"
} as const

export interface DotFilenConfirmDialogProps {
	open: boolean
	pending: boolean
	operation: DotFilenOperation
	// `.filen` is one of several items.
	multiple: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
}

// Confirms an operation on the root `.filen` by its name typed (lib/dotFilenGuard.ts). Cancel has focus: the
// operation was asked for, so the typing is the deliberate step.
export function DotFilenConfirmDialog({ open, pending, operation, multiple, onOpenChange, onConfirm }: DotFilenConfirmDialogProps) {
	const { t } = useTranslation(["drive", "common"])
	const values = { name: DOT_FILEN_DIR_NAME }

	return (
		<TypedConfirmDialog
			open={open}
			pending={pending}
			title={t(TITLE_KEYS[operation], values)}
			body={multiple ? t("driveDotFilenBodySelection", values) : t("driveDotFilenBody", values)}
			matchLabel={t("driveDotFilenMatchLabel", values)}
			matchValue={DOT_FILEN_DIR_NAME}
			confirmLabel={t(CONFIRM_KEYS[operation])}
			cancelLabel={t("common:cancel")}
			focusCancel
			onOpenChange={onOpenChange}
			onConfirm={onConfirm}
		/>
	)
}

// The prompt of a move (lib/dotFilenGuard.ts's confirmDotFilenOperation), mounted once at the root: a drop, a pasted
// cut or a picker's confirm may have no dialog of its own left to host it.
export function DotFilenGuardDialog() {
	const ask = useDotFilenAsk()
	// The last ask keeps its words through the exit animation.
	const [shown, setShown] = useState(ask)

	if (ask !== null && ask !== shown) {
		setShown(ask)
	}

	const last = ask ?? shown

	return (
		<DotFilenConfirmDialog
			open={ask !== null}
			pending={false}
			operation={last?.operation ?? "move"}
			multiple={last?.multiple ?? false}
			onOpenChange={open => {
				if (!open) {
					ask?.settle(false)
				}
			}}
			onConfirm={() => {
				ask?.settle(true)
			}}
		/>
	)
}
