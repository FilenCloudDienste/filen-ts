import { useState, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Maximize2Icon, MoveHorizontalIcon, MoveVerticalIcon } from "lucide-react"
import type { DeckOp, Xfrm } from "@filen/office/core/presentation"
import { Input } from "@/components/ui/input"
import { fromTwips, lengthUnit, toTwips, type DocxLengthUnit } from "@/features/preview/components/docxEditor.logic"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { useSmartArtDiagram } from "@/features/presentation/components/ribbon/insertSmartArt"

// The SmartArt Format tab: the graphic's frame size (height and width, in the locale's unit), one setXfrm per change;
// a frame the file locks against resizing keeps its size, and one locking its aspect keeps it. Its nodes have no
// format ops of their own.

const EMU_PER_TWIP = 635
// 1 mm to 51 in, the range PowerPoint's size fields take.
const MIN_EMU = 36_000
const MAX_EMU = 51 * 914_400

// The frame's box after typing `text` as its height or width (in `unit`); undefined when it is no length in range
// or changes nothing.
export function resizedXfrm(xfrm: Xfrm, axis: "cx" | "cy", text: string, unit: DocxLengthUnit, keepAspect: boolean): Xfrm | undefined {
	const twips = toTwips(text, unit)

	if (Number.isNaN(twips)) return undefined

	const value = Math.round(twips * EMU_PER_TWIP)

	if (value < MIN_EMU || value > MAX_EMU || value === xfrm[axis]) return undefined

	const other = axis === "cx" ? "cy" : "cx"
	const scaled = keepAspect && xfrm[axis] > 0 ? Math.round((xfrm[other] * value) / xfrm[axis]) : xfrm[other]

	if (scaled < MIN_EMU || scaled > MAX_EMU) return undefined

	// Its top left corner stays where it is.
	return axis === "cx" ? { ...xfrm, cx: value, cy: scaled } : { ...xfrm, cx: scaled, cy: value }
}

function shownLength(emu: number, unit: DocxLengthUnit): string {
	return String(fromTwips(emu / EMU_PER_TWIP, unit))
}

function SizeField({
	label,
	icon,
	value,
	disabled,
	onCommit
}: {
	label: string
	icon: ReactNode
	value: string
	disabled: boolean
	onCommit: (text: string) => boolean
}) {
	const [text, setText] = useState(value)
	const [shown, setShown] = useState(value)

	// The frame's size changed (a command, undo): the field shows it.
	if (shown !== value) {
		setShown(value)
		setText(value)
	}

	const commit = (): void => {
		if (text === value) return
		if (!onCommit(text)) setText(value)
	}

	return (
		<label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
			<span
				aria-hidden="true"
				className="[&_svg]:size-3.5"
			>
				{icon}
			</span>
			<Input
				value={text}
				inputMode="decimal"
				disabled={disabled}
				aria-label={label}
				title={label}
				className="h-7 w-16 px-1.5 text-xs leading-4 md:text-xs"
				onChange={event => {
					setText(event.target.value)
				}}
				onBlur={commit}
				onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
					if (event.key === "Enter") {
						event.preventDefault()
						commit()
					} else if (event.key === "Escape" && text !== value) {
						// The field's own Escape: what was typed is cancelled, and focus stays (the ribbon's Escape, which
						// moves focus and so commits on blur, comes with the next press).
						event.preventDefault()
						setText(value)
					}
				}}
			/>
		</label>
	)
}

function SizeControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { target, shape } = useSmartArtDiagram(editor)
	const unit = lengthUnit(navigator.language)
	const locked = shape === undefined || shape.locks?.noResize === true
	const commit = (axis: "cx" | "cy", text: string): boolean => {
		if (target === undefined || shape === undefined || locked) return false

		const xfrm = resizedXfrm(shape.xfrm, axis, text, unit, shape.locks?.noChangeAspect === true)

		if (xfrm === undefined) return false

		const op: DeckOp = { family: "shape", kind: "setXfrm", target, xfrm }

		void editor.command(op)

		return true
	}

	return (
		<>
			<SizeField
				label={t("previewPptxSmartArtHeight", { unit })}
				icon={<MoveVerticalIcon />}
				value={shape === undefined ? "" : shownLength(shape.xfrm.cy, unit)}
				disabled={locked}
				onCommit={text => commit("cy", text)}
			/>
			<SizeField
				label={t("previewPptxSmartArtWidth", { unit })}
				icon={<MoveHorizontalIcon />}
				value={shape === undefined ? "" : shownLength(shape.xfrm.cx, unit)}
				disabled={locked}
				onCommit={text => commit("cx", text)}
			/>
		</>
	)
}

export const smartartFormatGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [
		{
			id: "smartartSize",
			label: context.t("previewPptxSmartArtSize", { ns: "preview" }),
			icon: Maximize2Icon,
			width: 2 * 92,
			priority: 1,
			content: <SizeControls editor={editor} />
		}
	]
}
