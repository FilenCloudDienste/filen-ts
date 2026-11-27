import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import { HexColorPicker } from "react-colorful"
import { cn } from "@filen/shared"
import { DEFAULT_CUSTOM_HEX, normalizeCustomHex } from "@/features/drive/lib/dirColor"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export interface CustomColorPopoverProps {
	initialHex: string
	disabled: boolean
	selected: boolean
	offlineTitle: string | undefined
	onApply: (hex: string) => void
}

// The picker mounts only while the popover is open, so a closed dialog costs nothing extra.
function CustomColorForm({ initialHex, onApply }: Pick<CustomColorPopoverProps, "initialHex" | "onApply">) {
	const { t } = useTranslation("drive")
	const [text, setText] = useState(initialHex)
	const hex = normalizeCustomHex(text)

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={event => {
				event.preventDefault()

				if (hex !== null) {
					onApply(hex)
				}
			}}
		>
			<HexColorPicker
				color={hex ?? DEFAULT_CUSTOM_HEX}
				onChange={next => {
					setText(next)
				}}
				className="[&_.react-colorful\_\_hue]:h-3 [&_.react-colorful\_\_hue]:rounded-full [&_.react-colorful\_\_interactive:focus-visible_.react-colorful\_\_pointer]:ring-2 [&_.react-colorful\_\_interactive:focus-visible_.react-colorful\_\_pointer]:ring-ring [&_.react-colorful\_\_last-control]:mt-3 [&_.react-colorful\_\_pointer]:size-5 [&_.react-colorful\_\_saturation]:rounded-xl [&_.react-colorful\_\_saturation]:border-b-0 [&.react-colorful]:h-40 [&.react-colorful]:w-full"
			/>
			<div className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className="size-8 shrink-0 rounded-full ring-1 ring-foreground/10"
					style={{ backgroundColor: hex ?? DEFAULT_CUSTOM_HEX }}
				/>
				<FieldLabel
					htmlFor="drive-color-custom-hex"
					className="sr-only"
				>
					{t("driveColorHexLabel")}
				</FieldLabel>
				<Input
					id="drive-color-custom-hex"
					value={text}
					placeholder="#RRGGBB"
					maxLength={7}
					spellCheck={false}
					autoComplete="off"
					aria-invalid={hex === null}
					className="min-w-0 flex-1 font-mono"
					onChange={event => {
						setText(event.target.value)
					}}
				/>
				<Button
					type="submit"
					size="sm"
					disabled={hex === null}
				>
					{t("driveColorCustomApply")}
				</Button>
			</div>
		</form>
	)
}

export function CustomColorPopover({ initialHex, disabled, selected, offlineTitle, onApply }: CustomColorPopoverProps) {
	const { t } = useTranslation("drive")

	return (
		<Popover>
			<PopoverTrigger
				type="button"
				disabled={disabled}
				aria-label={t("driveColorCustomLabel")}
				title={offlineTitle ?? t("driveColorCustomLabel")}
				className={cn(
					"flex size-10 items-center justify-center rounded-full border border-dashed border-muted-foreground text-muted-foreground focus-ring-row outline-none hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
					selected && "ring-2 ring-ring ring-offset-2 ring-offset-popover"
				)}
			>
				<PlusIcon
					aria-hidden="true"
					className="size-4"
				/>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-64"
			>
				<CustomColorForm
					initialHex={initialHex}
					onApply={onApply}
				/>
			</PopoverContent>
		</Popover>
	)
}
