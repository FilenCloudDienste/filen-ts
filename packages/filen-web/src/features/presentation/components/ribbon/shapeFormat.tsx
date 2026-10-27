import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PaintBucketIcon, PenLineIcon } from "lucide-react"
import { oneStep, type DeckOp, type FillProps, type LineProps, type SlideRef } from "@filen/office/core/presentation"
import { selectedShapes, useShapeSelection } from "@filen/office/react/presentation"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { DocxColorGrid } from "@/features/office/components/officeColorGrid"
import { STANDARD_SWATCHES, keepFocus } from "@/features/office/lib/officeControls"
import { DocxColorButton } from "@/features/preview/components/docxFormatControls"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"

// The Shape Format tab: the fill and the outline (colour and weight) of the selected shapes, one op for all of them.
// Colours are sRGB, which both formats hold as they are (ODF graphic properties take no theme colours).

const BUTTON = 30
const EMU_PER_PT = 12_700
// PowerPoint's outline weights (pt).
const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6] as const

function solid(rgb: string): FillProps {
	return { kind: "solid", color: { kind: "srgb", rgb } }
}

function useFormatTargets(editor: PresentationRibbonEditor): { readonly slide: SlideRef | undefined; readonly ids: readonly number[] } {
	const state = useShapeSelection(editor.selection)
	const ids = selectedShapes(editor.render, state)
		.filter(shape => (shape.role === "shape" || shape.role === "placeholder") && shape.lock === undefined)
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
	const [weight, setWeight] = useState<number>(1)
	const [rgb, setRgb] = useState("000000")
	const apply = (ln: LineProps | "none"): void => {
		const op = slide === undefined ? undefined : propsOp(slide, ids, { ln })

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

							if (swatch === null) {
								apply("none")

								return
							}

							setRgb(swatch.rgb)
							apply({ w: Math.round(weight * EMU_PER_PT), fill: solid(swatch.rgb) })
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
								aria-pressed={points === weight}
								className={cn("justify-start text-xs", points === weight && "bg-accent")}
								onMouseDown={keepFocus}
								onClick={() => {
									close()
									setWeight(points)
									apply({ w: Math.round(points * EMU_PER_PT), fill: solid(rgb) })
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
		}
	]
}
