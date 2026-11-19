import { useTranslation } from "react-i18next"
import { PaintBucketIcon, PenLineIcon } from "lucide-react"
import { oneStep, type DeckOp, type FillProps, type LineProps, type SlideRef } from "@filen/office/core/presentation"
import { selectedShapes, useShapeSelection, type SlideShape } from "@filen/office/react/presentation"
import { Button } from "@/components/ui/button"
import { DocxColorGrid } from "@/features/office/components/officeColorGrid"
import { STANDARD_SWATCHES, keepFocus } from "@/features/office/lib/officeControls"
import { DocxColorButton } from "@/features/preview/components/docxFormatControls"
import { sizeGroup } from "@/features/presentation/components/ribbon/sizeControls"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"

// The Shape Format tab: the fill and the outline (colour and weight) of the selected shapes, one op for all of them,
// and their size. An outline colour or weight pick changes that field of each shape's line and keeps the rest (its
// weight or colour, dash, caps, joins and arrowheads).
// Colours are sRGB, which both formats hold as they are (ODF graphic properties take no theme colours).

const BUTTON = 30
const EMU_PER_PT = 12_700
// PowerPoint's outline weights (pt).
const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6] as const

function solid(rgb: string): FillProps {
	return { kind: "solid", color: { kind: "srgb", rgb } }
}

// The selected shapes this tab formats and sizes: shapes and placeholders the slide may edit.
function formats(shape: SlideShape): boolean {
	return (shape.role === "shape" || shape.role === "placeholder") && shape.lock === undefined
}

function useFormatTargets(editor: PresentationRibbonEditor): { readonly slide: SlideRef | undefined; readonly ids: readonly number[] } {
	const state = useShapeSelection(editor.selection)
	const ids = selectedShapes(editor.render, state)
		.filter(formats)
		.map(shape => shape.id)

	return { slide: editor.render?.ref, ids }
}

// One setProps per shape, one step.
function propsOp(
	slide: SlideRef,
	ids: readonly number[],
	props: { fill?: FillProps | "none"; ln?: LineProps | "none" }
): DeckOp | undefined {
	return oneStep(ids.map(id => ({ family: "shape", kind: "setProps", target: { slide, id }, props }) as const))[0]
}

// One patchLine per shape, one step: each shape's own line with `line`'s fields replaced.
function lineOp(slide: SlideRef, ids: readonly number[], line: LineProps): DeckOp | undefined {
	return oneStep(ids.map(id => ({ family: "shape", kind: "patchLine", target: { slide, id }, line }) as const))[0]
}

function FillControl({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { slide, ids } = useFormatTargets(editor)

	return (
		<DocxColorButton
			label={t("previewPptxShapeFill")}
			icon={<PaintBucketIcon />}
			rgb={undefined}
			disabled={slide === undefined || ids.length === 0}
		>
			{close => (
				<DocxColorGrid
					theme={[]}
					standard={STANDARD_SWATCHES}
					chosen={undefined}
					none={{ label: t("previewPptxShapeNoFill"), key: "none" }}
					onPick={swatch => {
						close()

						const op =
							slide === undefined ? undefined : propsOp(slide, ids, { fill: swatch === null ? "none" : solid(swatch.rgb) })

						if (op !== undefined) void editor.command(op)
					}}
				/>
			)}
		</DocxColorButton>
	)
}

function OutlineControl({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { slide, ids } = useFormatTargets(editor)
	const send = (op: DeckOp | undefined): void => {
		if (op !== undefined) void editor.command(op)
	}

	return (
		<DocxColorButton
			label={t("previewPptxShapeOutline")}
			icon={<PenLineIcon />}
			rgb={undefined}
			disabled={slide === undefined || ids.length === 0}
		>
			{close => (
				<div className="flex flex-col gap-2">
					<DocxColorGrid
						theme={[]}
						standard={STANDARD_SWATCHES}
						chosen={undefined}
						none={{ label: t("previewPptxShapeNoOutline"), key: "none" }}
						onPick={swatch => {
							close()

							if (slide === undefined) return

							send(swatch === null ? propsOp(slide, ids, { ln: "none" }) : lineOp(slide, ids, { fill: solid(swatch.rgb) }))
						}}
					/>
					<p className="text-xs text-muted-foreground">{t("previewPptxShapeOutlineWeight")}</p>
					<div
						role="group"
						aria-label={t("previewPptxShapeOutlineWeight")}
						className="grid grid-cols-3 gap-1"
					>
						{WEIGHTS.map(points => (
							<Button
								key={points}
								variant="ghost"
								size="sm"
								className="justify-start text-xs"
								onMouseDown={keepFocus}
								onClick={() => {
									close()

									if (slide !== undefined) send(lineOp(slide, ids, { w: Math.round(points * EMU_PER_PT) }))
								}}
							>
								{t("previewPptxShapeOutlinePoints", { points })}
							</Button>
						))}
					</div>
				</div>
			)}
		</DocxColorButton>
	)
}

export const shapeFormatGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [
		{
			id: "shapeStyles",
			label: context.t("previewPptxShapeStyles", { ns: "preview" }),
			icon: PaintBucketIcon,
			width: 2 * BUTTON,
			priority: 4,
			content: (
				<>
					<FillControl editor={editor} />
					<OutlineControl editor={editor} />
				</>
			)
		},
		sizeGroup(context, editor, "shapeSize", formats)
	]
}
