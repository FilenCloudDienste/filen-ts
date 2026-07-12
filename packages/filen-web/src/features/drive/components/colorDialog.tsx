import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { DirColor } from "@filen/sdk-rs"
import type { DriveKey } from "@/lib/i18n"
import { type DirectoryItem, setColor } from "@/features/drive/lib/actions"
import { dirColorHex, isCustomDirColor, normalizeCustomHex } from "@/features/drive/lib/dirColor"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { cn } from "@/lib/utils"
import { useIsOnline } from "@/lib/useIsOnline"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface ColorDialogProps {
	directory: DirectoryItem
	onClose: () => void
}

interface Swatch {
	color: DirColor
	labelKey: DriveKey
}

// The 6 named quick-pick colors — each swatch's fill comes from the shared dirColorHex map so it
// matches the tint the same directory shows in its listing row/tile and info-dialog hero. A freeform
// custom color (DirColor's own string arm) is offered separately below via the native browser color
// picker (mobile parity: DirColor.Custom, minus a hand-rolled hue/saturation canvas — see the custom
// section's own comment for why the native input is preferred here).
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
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const [pending, setPending] = useState(false)
	// Seeded from the directory's own current custom color when it has one, else a neutral starting
	// point — never one of the 6 named DIR_COLOR_HEX values, so the custom field never silently reads
	// as "already applied" for a directory that's merely using a named color.
	const [customHex, setCustomHex] = useState(isCustomDirColor(directory.data.color) ? dirColorHex(directory.data.color) : "#85bcff")
	const normalizedCustomHex = normalizeCustomHex(customHex)
	const customSelected = isCustomDirColor(directory.data.color)

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
								disabled={pending || !isOnline}
								aria-pressed={selected}
								aria-label={t(swatch.labelKey)}
								title={!isOnline ? t("common:offlineActionDisabled") : undefined}
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
				{/* Custom color — a native <input type="color"> rather than a hand-rolled hue/saturation
				canvas: every target browser's own color picker already renders exactly the "hue slider +
				saturation/value panel" mobile's screen describes, with its own hex entry, fully theme/
				accessibility-aware, at zero added bundle weight or pointer-math surface to maintain. The
				swatch shows the live picked color and doubles as the trigger (native inputs of this type
				open their picker on click/Enter); the text field mirrors the same value so a hex can also
				be typed or pasted directly, each side updating the other. */}
				<div className="flex items-center gap-3 border-t border-border/50 pt-4">
					<Field
						orientation="horizontal"
						className="flex-1 items-center"
					>
						<input
							type="color"
							aria-label={t("driveColorCustomLabel")}
							disabled={pending || !isOnline}
							value={normalizedCustomHex ?? "#85bcff"}
							onChange={event => {
								setCustomHex(event.target.value)
							}}
							className={cn(
								"size-10 shrink-0 cursor-pointer appearance-none rounded-full border-0 bg-transparent p-0 outline-none disabled:pointer-events-none disabled:opacity-50 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:rounded-full [&::-webkit-color-swatch-wrapper]:p-0",
								customSelected && "ring-2 ring-ring ring-offset-2 ring-offset-popover"
							)}
						/>
						<FieldContent>
							<FieldLabel htmlFor="drive-color-custom-hex">{t("driveColorCustomLabel")}</FieldLabel>
							<Input
								id="drive-color-custom-hex"
								value={customHex}
								disabled={pending || !isOnline}
								placeholder="#RRGGBB"
								maxLength={7}
								onChange={event => {
									setCustomHex(event.target.value)
								}}
							/>
						</FieldContent>
					</Field>
					<Button
						type="button"
						size="sm"
						disabled={pending || !isOnline || normalizedCustomHex === null}
						title={!isOnline ? t("common:offlineActionDisabled") : undefined}
						onClick={() => {
							if (normalizedCustomHex !== null) {
								void handleSelect(normalizedCustomHex)
							}
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("driveColorCustomApply")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
