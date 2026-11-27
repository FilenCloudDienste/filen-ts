import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon } from "lucide-react"
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import type { DirColor } from "@filen/sdk-rs"
import { type DirectoryItem, setColor } from "@/features/drive/lib/actions"
import {
	DEFAULT_CUSTOM_HEX,
	DIR_COLOR_SWATCHES,
	dirColorRadioValue,
	isCustomDirColor,
	withRecentDirColor
} from "@/features/drive/lib/dirColor"
import { loadRecentDirColors, saveRecentDirColors } from "@/features/drive/lib/recentDirColors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { dirColorHex } from "@filen/shared"
import { useIsOnline } from "@/lib/useIsOnline"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { RadioGroup } from "@/components/ui/radio-group"
import { CustomColorPopover } from "@/features/drive/components/customColorPopover"

export interface ColorDialogProps {
	directory: DirectoryItem
	onClose: () => void
}

interface SwatchProps {
	value: string
	label: string
	fill: string
	disabled: boolean
	title: string
}

function Swatch({ value, label, fill, disabled, title }: SwatchProps) {
	return (
		<RadioPrimitive.Root
			value={value}
			disabled={disabled}
			aria-label={label}
			title={title}
			className="flex size-10 items-center justify-center rounded-full focus-ring-row ring-1 ring-foreground/10 outline-none data-checked:ring-2 data-checked:ring-ring data-checked:ring-offset-2 data-checked:ring-offset-popover data-disabled:pointer-events-none data-disabled:opacity-50"
			style={{ backgroundColor: fill }}
		>
			<RadioPrimitive.Indicator>
				<CheckIcon
					aria-hidden="true"
					className="size-4 text-white"
				/>
			</RadioPrimitive.Indicator>
		</RadioPrimitive.Root>
	)
}

// Mounted-when-active by the listing's dialog host (directoryListing.tsx): there's no trigger left to
// anchor a popover to once the context menu that dispatched it has closed.
export function ColorDialog({ directory, onClose }: ColorDialogProps) {
	const { t } = useTranslation(["drive", "common"])
	const isOnline = useIsOnline()
	const [pending, setPending] = useState(false)
	const [recent, setRecent] = useState<string[]>([])
	const current = directory.data.color
	const selectedValue = dirColorRadioValue(current)
	const disabled = pending || !isOnline
	const offlineTitle = isOnline ? undefined : t("common:offlineActionDisabled")
	const onSwatch = DIR_COLOR_SWATCHES.some(swatch => swatch.value === selectedValue)
	const onRecent = recent.includes(selectedValue)

	useEffect(() => {
		let cancelled = false

		void loadRecentDirColors().then(list => {
			if (!cancelled) {
				setRecent(list)
			}
		})

		return () => {
			cancelled = true
		}
	}, [])

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			onClose()
		}
	})

	async function handleSelect(color: DirColor): Promise<void> {
		setPending(true)
		const outcome = await setColor(directory, color)
		setPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		if (isCustomDirColor(color)) {
			const next = withRecentDirColor(recent, color)

			if (next.length !== recent.length || next.some((each, index) => each !== recent[index])) {
				saveRecentDirColors(next)
			}
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
				<RadioGroup
					value={selectedValue}
					disabled={disabled}
					aria-label={t("driveColorSwatchesLabel")}
					className="gap-4 py-2"
					onValueChange={value => {
						if (typeof value === "string") {
							void handleSelect(value)
						}
					}}
				>
					<div className="grid grid-cols-6 gap-3">
						{DIR_COLOR_SWATCHES.map(swatch => (
							<Swatch
								key={swatch.value}
								value={swatch.value}
								label={t(swatch.labelKey)}
								fill={dirColorHex(swatch.value)}
								disabled={disabled}
								title={offlineTitle ?? t(swatch.labelKey)}
							/>
						))}
						<CustomColorPopover
							initialHex={isCustomDirColor(current) ? dirColorHex(current) : DEFAULT_CUSTOM_HEX}
							disabled={disabled}
							selected={!onSwatch && !onRecent}
							offlineTitle={offlineTitle}
							onApply={hex => {
								void handleSelect(hex)
							}}
						/>
					</div>
					{recent.length > 0 ? (
						<div
							role="group"
							aria-label={t("driveColorRecentLabel")}
							className="flex flex-col gap-2 border-t border-border/50 pt-4"
						>
							<span
								aria-hidden="true"
								className="text-xs text-muted-foreground"
							>
								{t("driveColorRecentLabel")}
							</span>
							<div className="flex gap-3">
								{recent.map(hex => (
									<Swatch
										key={hex}
										value={hex}
										label={hex.toUpperCase()}
										fill={hex}
										disabled={disabled}
										title={offlineTitle ?? hex.toUpperCase()}
									/>
								))}
							</div>
						</div>
					) : null}
				</RadioGroup>
			</DialogContent>
		</Dialog>
	)
}
