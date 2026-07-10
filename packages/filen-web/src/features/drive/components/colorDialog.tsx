import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { DirColor } from "@filen/sdk-rs"
import type { DriveKey } from "@/lib/i18n"
import { type DirectoryItem, setColor } from "@/features/drive/lib/actions"
import { dirColorHex } from "@/features/drive/lib/dirColor"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { cn } from "@/lib/utils"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export interface ColorDialogProps {
	directory: DirectoryItem
	onClose: () => void
}

interface Swatch {
	color: DirColor
	labelKey: DriveKey
}

// Only the 6 named colors are offered (no freeform hex picker on web yet, unlike mobile's
// DirColor.Custom); each swatch's fill comes from the shared dirColorHex map so it matches the tint
// the same directory shows in its listing row/tile and info-dialog hero.
const SWATCHES: Swatch[] = [
	{ color: "default", labelKey: "driveColorDefault" },
	{ color: "blue", labelKey: "driveColorBlue" },
	{ color: "green", labelKey: "driveColorGreen" },
	{ color: "purple", labelKey: "driveColorPurple" },
	{ color: "red", labelKey: "driveColorRed" },
	{ color: "gray", labelKey: "driveColorGray" }
]

// Small swatch-grid modal, mounted-when-active by the listing's dialog host (directoryListing.tsx) —
// there's no trigger element left to anchor a popover to by the time this opens (the context menu it
// was dispatched from is already closed), so this renders as a modal like its sibling dialogs.
export function ColorDialog({ directory, onClose }: ColorDialogProps) {
	const { t } = useTranslation("drive")
	const [pending, setPending] = useState(false)

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			// Also stops Base UI's own store from flipping (it closes itself after this callback
			// unless the event is canceled) — see dismissal.logic.ts.
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleSelect(color: DirColor): Promise<void> {
		setPending(true)
		const outcome = await setColor(directory, color)
		setPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		onClose()
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent closeButtonDisabled={pending}>
				<DialogHeader>
					<DialogTitle>{t("driveColorDialogTitle")}</DialogTitle>
				</DialogHeader>
				<div className="grid grid-cols-6 gap-3 py-2">
					{SWATCHES.map(swatch => {
						const selected = directory.data.color === swatch.color

						return (
							<button
								key={swatch.color}
								type="button"
								disabled={pending}
								aria-pressed={selected}
								aria-label={t(swatch.labelKey)}
								onClick={() => {
									void handleSelect(swatch.color)
								}}
								className={cn(
									"flex size-10 items-center justify-center rounded-full ring-1 ring-foreground/10 transition-transform outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
									selected && "ring-2 ring-ring ring-offset-2 ring-offset-popover"
								)}
								style={{ backgroundColor: dirColorHex(swatch.color) }}
							>
								{selected ? (
									<CheckIcon
										aria-hidden="true"
										className="size-4 text-white"
									/>
								) : null}
							</button>
						)
					})}
				</div>
			</DialogContent>
		</Dialog>
	)
}
