import { useEffect, useId, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CropIcon, ImageIcon, RefreshCcwIcon, SunMediumIcon, TextQuoteIcon } from "lucide-react"
import { oneStep, type DeckOp, type EdgeFractions, type PictureAdjust, type ShapeRef } from "@filen/office/core/presentation"
import type { PictureFormat, PresentationSessionApi } from "@filen/office/dom/presentation"
import { selectedShapes, useShapeSelection, type SlideShape } from "@filen/office/react/presentation"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { AltTextDialog } from "@/features/presentation/components/ribbon/arrange"
import { PictureSourceMenu } from "@/features/presentation/components/ribbon/insertObjects"
import { useRibbonDialog } from "@/features/presentation/components/ribbon/ribbonDialogs"
import { sizeGroup } from "@/features/presentation/components/ribbon/sizeControls"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Picture tab: corrections (brightness, contrast, transparency, grayscale), reset, Change Picture (this device or
// the drive, keeping the box), crop by edge and alt text, on the one picture selected. Every command is one op. Crop
// and Corrections start from the picture's own crop and adjustments (one read as they open) and send nothing when
// left as they were.

const BUTTON = 30
const MENU = 44

// The selected shapes the Size group sizes: pictures the slide may edit.
function isPicture(shape: SlideShape): boolean {
	return shape.role === "picture" && shape.lock === undefined
}

function useSelectedPicture(editor: PresentationRibbonEditor): { readonly target: ShapeRef; readonly shape: SlideShape } | undefined {
	const state = useShapeSelection(editor.selection)
	const selected = selectedShapes(editor.render, state)
	const only = selected.length === 1 && selected[0]?.role === "picture" ? selected[0] : undefined
	const slide = editor.render?.ref

	return only === undefined || slide === undefined ? undefined : { target: { slide, id: only.id }, shape: only }
}

// A percentage field's value (a decimal comma taken as a point), or undefined outside [min, max].
function percent(value: string, min: number, max: number): number | undefined {
	const trimmed = value.trim()
	const number = Number(trimmed === "" ? "0" : trimmed.replace(",", "."))

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

// 1/100,000 of the box (or of 100 %) as the percentage a field shows.
function shown(value: number | undefined): string {
	return String((value ?? 0) / 1000)
}

function scaled(value: number | undefined): number {
	return Math.round((value ?? 0) * 1000)
}

// The picture's crop and adjustments, read once when its dialog opens; the dialog shows once they are known (a read
// that fails starts it from none).
function WithPictureFormat({
	session,
	target,
	children
}: {
	session: PresentationSessionApi
	target: ShapeRef
	children: (format: PictureFormat) => ReactNode
}) {
	const [format, setFormat] = useState<PictureFormat | undefined>(undefined)

	useEffect(() => {
		let live = true

		session.pictureFormat(target).then(
			read => {
				if (live) setFormat(read)
			},
			() => {
				if (live) setFormat({})
			}
		)

		return () => {
			live = false
		}
	}, [session, target])

	return format === undefined ? null : children(format)
}

function CropDialog({
	target,
	crop: current,
	run,
	onClose
}: {
	target: ShapeRef
	crop: EdgeFractions | undefined
	run: (op: DeckOp) => void
	onClose: () => void
}) {
	const { t } = useTranslation("preview")
	const [edges, setEdges] = useState({ l: shown(current?.l), t: shown(current?.t), r: shown(current?.r), b: shown(current?.b) })
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

				const crop = { l: scaled(values.l), t: scaled(values.t), r: scaled(values.r), b: scaled(values.b) }
				const none = crop.l === 0 && crop.t === 0 && crop.r === 0 && crop.b === 0
				const unchanged =
					crop.l === (current?.l ?? 0) &&
					crop.t === (current?.t ?? 0) &&
					crop.r === (current?.r ?? 0) &&
					crop.b === (current?.b ?? 0)

				if (!unchanged) run({ family: "picture", kind: "crop", target, crop: none ? undefined : crop })

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

function CorrectionsDialog({
	target,
	adjust: current,
	run,
	onClose
}: {
	target: ShapeRef
	adjust: PictureAdjust | undefined
	run: (op: DeckOp) => void
	onClose: () => void
}) {
	const { t } = useTranslation("preview")
	const [brightness, setBrightness] = useState(shown(current?.brightness))
	const [contrast, setContrast] = useState(shown(current?.contrast))
	const [transparency, setTransparency] = useState(shown(current?.alpha))
	const [grayscale, setGrayscale] = useState(current?.grayscale === true)
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

				const next = {
					brightness: scaled(values.brightness),
					contrast: scaled(values.contrast),
					alpha: scaled(values.transparency)
				}
				const unchanged =
					next.brightness === (current?.brightness ?? 0) &&
					next.contrast === (current?.contrast ?? 0) &&
					next.alpha === (current?.alpha ?? 0) &&
					grayscale === (current?.grayscale === true)

				if (!unchanged) {
					// What the dialog does not show (bi-level, duotone) stays as the picture has it.
					const kept = {
						...(current?.biLevel === undefined ? {} : { biLevel: current.biLevel }),
						...(current?.duotone === undefined ? {} : { duotone: current.duotone })
					}

					run({
						family: "picture",
						kind: "adjust",
						target,
						adjust: {
							...kept,
							...(next.brightness === 0 ? {} : { brightness: next.brightness }),
							...(next.contrast === 0 ? {} : { contrast: next.contrast }),
							...(next.alpha === 0 ? {} : { alpha: next.alpha }),
							...(grayscale ? { grayscale: true } : {})
						}
					})
				}

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
	const dialog = useRibbonDialog(editor)
	const run = (op: DeckOp): void => {
		void editor.command(op)
	}
	const open = (kind: "crop" | "corrections" | "alt"): void => {
		if (picture === undefined) return

		const { target, shape } = picture

		dialog.open((live, close) => {
			const apply = (op: DeckOp): void => {
				void live.command(op)
			}

			return kind === "crop" ? (
				<WithPictureFormat
					session={live.session}
					target={target}
				>
					{format => (
						<CropDialog
							target={target}
							crop={format.crop}
							run={apply}
							onClose={close}
						/>
					)}
				</WithPictureFormat>
			) : kind === "corrections" ? (
				<WithPictureFormat
					session={live.session}
					target={target}
				>
					{format => (
						<CorrectionsDialog
							target={target}
							adjust={format.adjust}
							run={apply}
							onClose={close}
						/>
					)}
				</WithPictureFormat>
			) : (
				<AltTextDialog
					shape={shape}
					slide={target.slide}
					run={apply}
					onClose={close}
				/>
			)
		})
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
							open("corrections")
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
							open("crop")
						}}
					/>
					<RibbonButton
						label={t("previewPptxAltText")}
						icon={<TextQuoteIcon />}
						disabled={picture === undefined}
						onClick={() => {
							open("alt")
						}}
					/>
				</>
			)}
			{dialog.view}
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
		},
		sizeGroup(context, editor, "pictureSize", isPicture)
	]
}
