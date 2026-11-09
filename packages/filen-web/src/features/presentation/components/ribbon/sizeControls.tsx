import { useState, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Maximize2Icon, MoveHorizontalIcon, MoveVerticalIcon } from "lucide-react"
import { oneStep, type DeckOp, type SlideRef, type Xfrm } from "@filen/office/core/presentation"
import { ownXfrm, selectedShapes, useShapeSelection, type SlideShape } from "@filen/office/react/presentation"
import { Input } from "@/components/ui/input"
import { fromTwips, lengthUnit, toTwips, type DocxLengthUnit } from "@/features/preview/components/docxEditor.logic"
import type { PresentationRibbonContext, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"

// The Size group of the Shape Format, Picture Format and SmartArt Format tabs: the height and width of the selected
// frames in the locale's unit, one setXfrm per frame in one undo step. A field shows a value only when every frame
// shares it; a frame the file locks against resizing turns both fields off, and one locking its aspect keeps it.

const EMU_PER_TWIP = 635
// 1 mm to 51 in, the range PowerPoint's size fields take.
const MIN_EMU = 36_000
const MAX_EMU = 51 * 914_400

type Axis = "cx" | "cy"

// `text` as EMU (in `unit`); undefined when it is no length in range.
function typedLength(text: string, unit: DocxLengthUnit): number | undefined {
	const twips = toTwips(text, unit)

	if (Number.isNaN(twips)) return undefined

	const value = Math.round(twips * EMU_PER_TWIP)

	return value < MIN_EMU || value > MAX_EMU ? undefined : value
}

// The box with `axis` set to `value` EMU, its top left corner kept; null when that changes nothing, undefined when
// keeping the aspect takes the other side out of range.
function resizedTo(xfrm: Xfrm, axis: Axis, value: number, keepAspect: boolean): Xfrm | null | undefined {
	if (value === xfrm[axis]) return null

	const other = axis === "cx" ? "cy" : "cx"
	const scaled = keepAspect && xfrm[axis] > 0 ? Math.round((xfrm[other] * value) / xfrm[axis]) : xfrm[other]

	if (scaled < MIN_EMU || scaled > MAX_EMU) return undefined

	return axis === "cx" ? { ...xfrm, cx: value, cy: scaled } : { ...xfrm, cx: scaled, cy: value }
}

// The frame's box after typing `text` as its height or width (in `unit`); undefined when it is no length in range
// or changes nothing.
export function resizedXfrm(xfrm: Xfrm, axis: Axis, text: string, unit: DocxLengthUnit, keepAspect: boolean): Xfrm | undefined {
	const value = typedLength(text, unit)

	return value === undefined ? undefined : (resizedTo(xfrm, axis, value, keepAspect) ?? undefined)
}

// The op that gives every shape `text` as its height or width, one step; undefined when the text is no length in
// range, a shape is locked against resizing, keeping a shape's aspect takes it out of range, or nothing changes.
export function sizeOp(slide: SlideRef, shapes: readonly SlideShape[], axis: Axis, text: string, unit: DocxLengthUnit): DeckOp | undefined {
	const value = typedLength(text, unit)

	if (value === undefined || shapes.some(shape => shape.locks?.noResize === true)) return undefined

	const ops: DeckOp[] = []

	for (const shape of shapes) {
		const xfrm = resizedTo(shape.xfrm, axis, value, shape.locks?.noChangeAspect === true)

		if (xfrm === undefined) return undefined
		// A group member's size is its size on the slide, written back in its group's child space.
		if (xfrm !== null) ops.push({ family: "shape", kind: "setXfrm", target: { slide, id: shape.id }, xfrm: ownXfrm(shape, xfrm) })
	}

	return oneStep(ops)[0]
}

// The length every shape shares on `axis`, in `unit`; empty when they differ or there are none.
export function sharedLength(shapes: readonly SlideShape[], axis: Axis, unit: DocxLengthUnit): string {
	const first = shapes[0]

	if (first === undefined) return ""

	const emu = first.xfrm[axis]

	return shapes.every(shape => shape.xfrm[axis] === emu) ? String(fromTwips(emu / EMU_PER_TWIP, unit)) : ""
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

	// The frames' size changed (a command, undo, another selection): the field shows it.
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

function SizeControls({ editor, sizes }: { editor: PresentationRibbonEditor; sizes: (shape: SlideShape) => boolean }) {
	const { t } = useTranslation("preview")
	const state = useShapeSelection(editor.selection)
	const shapes = selectedShapes(editor.render, state).filter(sizes)
	const slide = editor.render?.ref
	const unit = lengthUnit(navigator.language)
	const disabled = slide === undefined || shapes.length === 0 || shapes.some(shape => shape.locks?.noResize === true)
	const commit = (axis: Axis, text: string): boolean => {
		const op = disabled ? undefined : sizeOp(slide, shapes, axis, text, unit)

		if (op === undefined) return false

		void editor.command(op)

		return true
	}

	return (
		<>
			<SizeField
				label={t("previewPptxSizeHeight", { unit })}
				icon={<MoveVerticalIcon />}
				value={sharedLength(shapes, "cy", unit)}
				disabled={disabled}
				onCommit={text => commit("cy", text)}
			/>
			<SizeField
				label={t("previewPptxSizeWidth", { unit })}
				icon={<MoveHorizontalIcon />}
				value={sharedLength(shapes, "cx", unit)}
				disabled={disabled}
				onCommit={text => commit("cx", text)}
			/>
		</>
	)
}

// The Size group over the selected shapes `sizes` takes (a module-level predicate).
export function sizeGroup(
	context: PresentationRibbonContext,
	editor: PresentationRibbonEditor,
	id: string,
	sizes: (shape: SlideShape) => boolean
): RibbonGroup {
	return {
		id,
		label: context.t("previewPptxSize", { ns: "preview" }),
		icon: Maximize2Icon,
		width: 2 * 92,
		priority: 1,
		content: (
			<SizeControls
				editor={editor}
				sizes={sizes}
			/>
		)
	}
}
