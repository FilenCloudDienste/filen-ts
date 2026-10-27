import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { CropIcon, ImageIcon, RefreshCcwIcon, SunMediumIcon, TextQuoteIcon } from "lucide-react"
import { oneStep, type DeckOp, type ShapeRef } from "@filen/office/core/presentation"
import { selectedShapes, useShapeSelection, type SlideShape } from "@filen/office/react/presentation"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { AltTextDialog } from "@/features/presentation/components/ribbon/arrange"
import { PictureSourceMenu } from "@/features/presentation/components/ribbon/insertObjects"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Picture tab: corrections (brightness, contrast, transparency, grayscale), reset, Change Picture (this device or
// the drive, keeping the box), crop by edge and alt text, on the one picture selected. Every command is one op.

const BUTTON = 30
const MENU = 44

function useSelectedPicture(editor: PresentationRibbonEditor): { readonly target: ShapeRef; readonly shape: SlideShape } | undefined {
	const state = useShapeSelection(editor.selection)
	const selected = selectedShapes(editor.render, state)
	const only = selected.length === 1 && selected[0]?.role === "picture" ? selected[0] : undefined
	const slide = editor.render?.ref

	return only === undefined || slide === undefined ? undefined : { target: { slide, id: only.id }, shape: only }
}

// A percentage field's value, or undefined outside [min, max].
function percent(value: string, min: number, max: number): number | undefined {
	const number = Number(value.trim() === "" ? "0" : value)

	return Number.isFinite(number) && number >= min && number <= max ? number : undefined
}

function NumberField({
	label,
	value,
	min,
	max,
	onChange
}: {
	label: PreviewKey
	value: string
	min: number
	max: number
	onChange: (value: string) => void
}) {
	const { t } = useTranslation("preview")
	const id = useId()
	const invalid = percent(value, min, max) === undefined

	return (
		<Field data-invalid={invalid}>
			<FieldLabel htmlFor={id}>{t(label)}</FieldLabel>
			<Input
				id={id}
				inputMode="decimal"
				value={value}
				aria-invalid={invalid}
				onChange={event => {
					onChange(event.target.value)
				}}
			/>
			{invalid ? <FieldError>{t("previewPptxValueRange", { min, max })}</FieldError> : null}
		</Field>
	)
}

function CropDialog({ target, run, onClose }: { target: ShapeRef; run: (op: DeckOp) => void; onClose: () => void }) {
	const { t } = useTranslation("preview")
	const [edges, setEdges] = useState({ l: "0", t: "0", r: "0", b: "0" })
	const values = { l: percent(edges.l, 0, 99), t: percent(edges.t, 0, 99), r: percent(edges.r, 0, 99), b: percent(edges.b, 0, 99) }
	const valid = Object.values(values).every(value => value !== undefined)
	const leaves = valid && (values.l ?? 0) + (values.r ?? 0) < 100 && (values.t ?? 0) + (values.b ?? 0) < 100
	const field = (key: keyof typeof edges, label: PreviewKey) => (
		<NumberField
			label={label}
			value={edges[key]}
			min={0}
			max={99}
			onChange={value => {
				setEdges(previous => ({ ...previous, [key]: value }))
			}}
		/>
	)

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxPictureCrop")}
			description={t("previewPptxPictureCropDescription")}
			submitLabel={t("previewPptxObjectsApply")}
			cancelLabel={t("previewPptxInsertCancel")}
			canSubmit={leaves}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				const fraction = (value: number | undefined): number => Math.round((value ?? 0) * 1000)
				const crop = { l: fraction(values.l), t: fraction(values.t), r: fraction(values.r), b: fraction(values.b) }
				const none = crop.l === 0 && crop.t === 0 && crop.r === 0 && crop.b === 0

				run({ family: "picture", kind: "crop", target, crop: none ? undefined : crop })
				onClose()
			}}
		>
			<div className="grid grid-cols-2 gap-3">
				{field("l", "previewPptxPictureCropLeft")}
				{field("r", "previewPptxPictureCropRight")}
				{field("t", "previewPptxPictureCropTop")}
				{field("b", "previewPptxPictureCropBottom")}
			</div>
			{valid && !leaves ? <FieldError>{t("previewPptxPictureCropTooMuch")}</FieldError> : null}
		</FormDialog>
	)
}

function CorrectionsDialog({ target, run, onClose }: { target: ShapeRef; run: (op: DeckOp) => void; onClose: () => void }) {
	const { t } = useTranslation("preview")
	const [brightness, setBrightness] = useState("0")
	const [contrast, setContrast] = useState("0")
	const [transparency, setTransparency] = useState("0")
	const [grayscale, setGrayscale] = useState(false)
	const grayId = useId()
	const values = {
		brightness: percent(brightness, -100, 100),
		contrast: percent(contrast, -100, 100),
		transparency: percent(transparency, 0, 100)
	}
	const valid = Object.values(values).every(value => value !== undefined)

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxPictureCorrections")}
			description={t("previewPptxPictureCorrectionsDescription")}
			submitLabel={t("previewPptxObjectsApply")}
			cancelLabel={t("previewPptxInsertCancel")}
			canSubmit={valid}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				const scaled = (value: number | undefined): number => Math.round((value ?? 0) * 1000)

				run({
					family: "picture",
					kind: "adjust",
					target,
					adjust: {
						brightness: scaled(values.brightness),
						contrast: scaled(values.contrast),
						alpha: scaled(values.transparency),
						grayscale
					}
				})
				onClose()
			}}
		>
			<NumberField
				label="previewPptxPictureBrightness"
				value={brightness}
				min={-100}
				max={100}
				onChange={setBrightness}
			/>
			<NumberField
				label="previewPptxPictureContrast"
				value={contrast}
				min={-100}
				max={100}
				onChange={setContrast}
			/>
			<NumberField
				label="previewPptxPictureTransparency"
				value={transparency}
				min={0}
				max={100}
				onChange={setTransparency}
			/>
			<Field orientation="horizontal">
				<Switch
					id={grayId}
					checked={grayscale}
					onCheckedChange={setGrayscale}
				/>
				<Label htmlFor={grayId}>{t("previewPptxPictureGrayscale")}</Label>
			</Field>
		</FormDialog>
	)
}

function PictureControls({ editor, group }: { editor: PresentationRibbonEditor; group: "adjust" | "arrange" }) {
	const { t } = useTranslation("preview")
	const picture = useSelectedPicture(editor)
	const [dialog, setDialog] = useState<"crop" | "corrections" | "alt" | undefined>(undefined)
	const run = (op: DeckOp): void => {
		void editor.command(op)
	}
	const close = (): void => {
		setDialog(undefined)
	}

	return (
		<>
			{group === "adjust" ? (
				<>
					<RibbonButton
						label={t("previewPptxPictureCorrections")}
						icon={<SunMediumIcon />}
						disabled={picture === undefined}
						onClick={() => {
							setDialog("corrections")
						}}
					/>
					{picture === undefined ? (
						<RibbonButton
							label={t("previewPptxPictureChange")}
							icon={<ImageIcon />}
							disabled
							onClick={() => undefined}
						/>
					) : (
						<PictureSourceMenu
							editor={editor}
							label={t("previewPptxPictureChange")}
							icon={<ImageIcon />}
							replace={picture.target.id}
						/>
					)}
					<RibbonButton
						label={t("previewPptxPictureReset")}
						icon={<RefreshCcwIcon />}
						disabled={picture === undefined}
						onClick={() => {
							if (picture === undefined) return

							const [op] = oneStep([
								{ family: "picture", kind: "adjust", target: picture.target, adjust: undefined },
								{ family: "picture", kind: "crop", target: picture.target, crop: undefined }
							])

							if (op !== undefined) run(op)
						}}
					/>
				</>
			) : (
				<>
					<RibbonButton
						label={t("previewPptxPictureCrop")}
						icon={<CropIcon />}
						disabled={picture === undefined}
						onClick={() => {
							setDialog("crop")
						}}
					/>
					<RibbonButton
						label={t("previewPptxAltText")}
						icon={<TextQuoteIcon />}
						disabled={picture === undefined}
						onClick={() => {
							setDialog("alt")
						}}
					/>
				</>
			)}
			{picture === undefined ? null : dialog === "crop" ? (
				<CropDialog
					target={picture.target}
					run={run}
					onClose={close}
				/>
			) : dialog === "corrections" ? (
				<CorrectionsDialog
					target={picture.target}
					run={run}
					onClose={close}
				/>
			) : dialog === "alt" ? (
				<AltTextDialog
					shape={picture.shape}
					slide={picture.target.slide}
					run={run}
					onClose={close}
				/>
			) : null}
		</>
	)
}

export const pictureGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	const t = context.t

	return [
		{
			id: "adjust",
			label: t("previewPptxPictureAdjust", { ns: "preview" }),
			icon: SunMediumIcon,
			width: 2 * BUTTON + MENU,
			priority: 3,
			content: (
				<PictureControls
					editor={editor}
					group="adjust"
				/>
			)
		},
		{
			id: "crop",
			label: t("previewPptxPictureCrop", { ns: "preview" }),
			icon: CropIcon,
			width: 2 * BUTTON,
			priority: 4,
			content: (
				<PictureControls
					editor={editor}
					group="arrange"
				/>
			)
		}
	]
}
