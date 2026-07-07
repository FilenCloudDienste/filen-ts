import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { DirColor } from "@filen/sdk-rs"
import type { DriveKey } from "@/lib/i18n"
import { type DirectoryItem, setColor } from "@/lib/drive/actions"
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
	// Mirrors filen-mobile's directoryColorToHex (components/itemIcons/index.tsx) so the swatch a user
	// picks here looks the same on both platforms — only the 6 named colors are offered (no freeform
	// hex picker on web yet, unlike mobile's DirColor.Custom).
	hex: string
}

const SWATCHES: Swatch[] = [
	{ color: "default", labelKey: "driveColorDefault", hex: "#85BCFF" },
	{ color: "blue", labelKey: "driveColorBlue", hex: "#037AFF" },
	{ color: "green", labelKey: "driveColorGreen", hex: "#33C759" },
	{ color: "purple", labelKey: "driveColorPurple", hex: "#AF52DE" },
	{ color: "red", labelKey: "driveColorRed", hex: "#FF3B30" },
	{ color: "gray", labelKey: "driveColorGray", hex: "#8F8E93" }
]

// Small swatch-grid modal, mounted-when-active by the listing's dialog host (directory-listing.tsx) —
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
								style={{ backgroundColor: swatch.hex }}
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
