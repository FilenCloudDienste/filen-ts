import { useRef, useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ChevronDownIcon, PaintBucketIcon } from "lucide-react"
import { BACKGROUND_PATTERNS, backgroundOp, type FillProps, type InsertedImage, type SlideRef } from "@filen/office/core/presentation"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DocxColorGrid } from "@/features/office/components/officeColorGrid"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { fileSource } from "@/features/preview/lib/docxImages"
import { pictureRefusalKey } from "@/features/preview/lib/docxImages.logic"
import {
	STANDARD_PRESENTATION_SWATCHES,
	customColor,
	hidesGraphics,
	themeSwatches,
	type PickedColor,
	type PresentationSwatch
} from "@/features/presentation/components/design/design.logic"
import { designState } from "@/features/presentation/components/design/designState"
import { preparePresentationPicture } from "@/features/presentation/components/ribbon/insertObjects"
import {
	closeDesignDialog,
	openDesignDialog,
	useDesignDialog,
	useDesignHosted
} from "@/features/presentation/components/design/designDialogs"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import type { PreviewKey } from "@/lib/i18n"

// Format Background: a solid, gradient, picture or pattern fill for the selected slides (Apply) or every slide (Apply
// to all), whether the master's shapes show on them, and Reset (back to the layout's background).

type Kind = "solid" | "gradient" | "picture" | "pattern"

const KINDS: readonly { readonly value: Kind; readonly label: PreviewKey }[] = [
	{ value: "solid", label: "previewPptxDesignBackgroundSolid" },
	{ value: "gradient", label: "previewPptxDesignBackgroundGradient" },
	{ value: "picture", label: "previewPptxDesignBackgroundPicture" },
	{ value: "pattern", label: "previewPptxDesignBackgroundPattern" }
]

// ECMA-376 a:lin@ang, 60,000ths of a degree.
const DIRECTIONS = [
	{ value: "down", label: "previewPptxDesignBackgroundDown", angle: 5_400_000 },
	{ value: "right", label: "previewPptxDesignBackgroundRight", angle: 0 },
	{ value: "diagonal", label: "previewPptxDesignBackgroundDiagonal", angle: 2_700_000 }
] as const

type Direction = (typeof DIRECTIONS)[number]["value"]
type Pattern = (typeof BACKGROUND_PATTERNS)[number]

// `hideGraphics`: set once the user switches it (undefined: the slide's own state, which is not sent).
interface Draft {
	readonly kind: Kind
	readonly color: PickedColor
	readonly from: PickedColor
	readonly to: PickedColor
	readonly direction: Direction
	readonly pattern: Pattern
	readonly foreground: PickedColor
	readonly back: PickedColor
	readonly picture: { readonly image: InsertedImage; readonly name: string } | undefined
	readonly hideGraphics: boolean | undefined
}

function backgroundFill(draft: Draft): FillProps | undefined {
	switch (draft.kind) {
		case "solid":
			return { kind: "solid", color: draft.color.model }
		case "gradient":
			return {
				kind: "gradient",
				stops: [
					{ pos: 0, color: draft.from.model },
					{ pos: 100_000, color: draft.to.model }
				],
				linear: { angle: DIRECTIONS.find(direction => direction.value === draft.direction)?.angle ?? 5_400_000, scaled: false }
			}
		case "pattern":
			return { kind: "pattern", preset: draft.pattern, fg: draft.foreground.model, bg: draft.back.model }
		case "picture":
			return draft.picture === undefined ? undefined : { kind: "picture", stretch: { l: 0, t: 0, r: 0, b: 0 } }
	}
}

// A colour: a button showing it, opening the theme's and the standard swatches (the editors' picker), and any other
// through the system picker beside it.
function ColorField({
	id,
	label,
	value,
	theme,
	onChange
}: {
	id: string
	label: string
	value: PickedColor
	theme: readonly PresentationSwatch[]
	onChange: (color: PickedColor) => void
}) {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)
	const name = value.label === undefined ? `#${value.rgb}` : t(value.label.name)

	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<div className="flex items-center gap-2">
				<Popover
					open={open}
					onOpenChange={setOpen}
				>
					<PopoverTrigger
						render={
							<Button
								id={id}
								type="button"
								variant="outline"
								aria-label={t("previewPptxDesignBackgroundColorValue", { label, color: name })}
								size="sm"
								className="min-w-0 flex-1 justify-start gap-2"
							>
								<span
									aria-hidden="true"
									className="size-4 shrink-0 rounded-sm ring-1 ring-border"
									style={{ backgroundColor: `#${value.rgb}` }}
								/>
								<span className="min-w-0 flex-1 truncate text-start">{name}</span>
								<ChevronDownIcon className="opacity-60" />
							</Button>
						}
					/>
					<PopoverContent
						data-preview-surface
						className="w-auto gap-2 p-3"
					>
						<DocxColorGrid
							theme={theme.length === 0 ? [] : [theme]}
							standard={STANDARD_PRESENTATION_SWATCHES}
							chosen={value.key}
							onPick={swatch => {
								const picked =
									swatch === null
										? undefined
										: [...theme, ...STANDARD_PRESENTATION_SWATCHES].find(each => each.key === swatch.key)

								setOpen(false)

								if (picked !== undefined) onChange(picked)
							}}
						/>
					</PopoverContent>
				</Popover>
				<input
					type="color"
					aria-label={t("previewPptxDesignBackgroundColorValue", { label, color: t("previewPptxDesignBackgroundMoreColors") })}
					title={t("previewPptxDesignBackgroundMoreColors")}
					value={`#${value.rgb.toLowerCase()}`}
					className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent"
					onChange={event => {
						onChange(customColor(event.target.value.slice(1)))
					}}
				/>
			</div>
		</Field>
	)
}

export function BackgroundDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useTranslation(["preview", "common"])
	const editor = usePresentationEditor()?.editor
	const { current } = designState(editor)
	const odp = editor?.document.info?.format === "odp"
	const themeColors = themeSwatches(current?.colors, odp)
	const hidden = hidesGraphics(editor?.currentRef === undefined ? undefined : editor.document.renders.get(editor.currentRef))
	const [draft, setDraft] = useState<Draft>(() => {
		const [background, text, accent] = themeColors

		return {
			kind: "solid",
			color: background ?? customColor("FFFFFF"),
			from: background ?? customColor("FFFFFF"),
			to: accent ?? customColor("4472C4"),
			direction: "down",
			pattern: "pct25",
			foreground: text ?? customColor("000000"),
			back: background ?? customColor("FFFFFF"),
			picture: undefined,
			hideGraphics: undefined
		}
	})
	const [pending, setPending] = useState(false)
	const picker = useRef<HTMLInputElement>(null)
	const set = (patch: Partial<Draft>): void => {
		setDraft(previous => ({ ...previous, ...patch }))
	}
	const fill = backgroundFill(draft)
	const editable = editor?.editable === true
	const apply = (slides: readonly SlideRef[], reset: boolean): void => {
		if (editor === undefined || slides.length === 0) return

		const graphics = draft.hideGraphics === undefined ? {} : { hideGraphics: draft.hideGraphics }
		const op = reset
			? backgroundOp(slides, undefined, graphics)
			: backgroundOp(slides, fill, {
					...graphics,
					...(draft.kind === "picture" && draft.picture !== undefined ? { image: draft.picture.image } : {})
				})

		setPending(true)
		void editor.command(op).then(result => {
			setPending(false)

			if (result.ok) onOpenChange(false)
		})
	}
	const every = (): readonly SlideRef[] => editor?.document.slides.map(slide => slide.ref) ?? []

	return (
		<Dialog
			open={open}
			onOpenChange={next => {
				if (!pending) onOpenChange(next)
			}}
		>
			<DialogContent
				closeButtonDisabled={pending}
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
			>
				<form
					className="flex flex-col gap-6"
					onSubmit={(event: SubmitEvent) => {
						event.preventDefault()
						apply(editor?.selection ?? [], false)
					}}
				>
					<DialogHeader>
						<DialogTitle>{t("previewPptxDesignFormatBackground")}</DialogTitle>
						<DialogDescription>{t("previewPptxDesignBackgroundBody")}</DialogDescription>
					</DialogHeader>
					<FieldGroup>
						<Field>
							<FieldLabel id="pptx-bg-kind">{t("previewPptxDesignBackgroundFill")}</FieldLabel>
							<RadioGroup
								aria-labelledby="pptx-bg-kind"
								value={draft.kind}
								className="grid grid-cols-2 gap-2 sm:grid-cols-4"
								onValueChange={value => {
									const kind = KINDS.find(entry => entry.value === value)?.value

									if (kind !== undefined) set({ kind })
								}}
							>
								{KINDS.map(entry => (
									<label
										key={entry.value}
										className="flex items-center gap-2 text-sm"
									>
										<RadioGroupItem value={entry.value} />
										{t(entry.label)}
									</label>
								))}
							</RadioGroup>
						</Field>
						{draft.kind === "solid" ? (
							<ColorField
								id="pptx-bg-color"
								label={t("previewPptxDesignBackgroundColor")}
								value={draft.color}
								theme={themeColors}
								onChange={color => {
									set({ color })
								}}
							/>
						) : null}
						{draft.kind === "gradient" ? (
							<>
								<ColorField
									id="pptx-bg-from"
									label={t("previewPptxDesignBackgroundFrom")}
									value={draft.from}
									theme={themeColors}
									onChange={from => {
										set({ from })
									}}
								/>
								<ColorField
									id="pptx-bg-to"
									label={t("previewPptxDesignBackgroundTo")}
									value={draft.to}
									theme={themeColors}
									onChange={to => {
										set({ to })
									}}
								/>
								<DocxChoiceField
									label={t("previewPptxDesignBackgroundDirection")}
									value={draft.direction}
									items={DIRECTIONS.map(direction => ({ value: direction.value, label: t(direction.label) }))}
									onChange={direction => {
										set({ direction })
									}}
								/>
							</>
						) : null}
						{draft.kind === "pattern" ? (
							<>
								<DocxChoiceField
									label={t("previewPptxDesignBackgroundPatternKind")}
									value={draft.pattern}
									items={BACKGROUND_PATTERNS.map(pattern => ({
										value: pattern,
										label: t(`previewPptxDesignPattern_${pattern}`)
									}))}
									onChange={pattern => {
										set({ pattern })
									}}
								/>
								<ColorField
									id="pptx-bg-fg"
									label={t("previewPptxDesignBackgroundForeground")}
									value={draft.foreground}
									theme={themeColors}
									onChange={foreground => {
										set({ foreground })
									}}
								/>
								<ColorField
									id="pptx-bg-back"
									label={t("previewPptxDesignBackgroundBack")}
									value={draft.back}
									theme={themeColors}
									onChange={back => {
										set({ back })
									}}
								/>
							</>
						) : null}
						{draft.kind === "picture" ? (
							<Field>
								<div className="flex flex-wrap items-center gap-3">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											picker.current?.click()
										}}
									>
										{t("previewPptxDesignBackgroundChoosePicture")}
									</Button>
									<span className="min-w-0 truncate text-sm text-muted-foreground">
										{draft.picture?.name ?? t("previewPptxDesignBackgroundNoPicture")}
									</span>
								</div>
								<input
									ref={picker}
									type="file"
									accept="image/*"
									hidden
									onChange={event => {
										const file = event.target.files?.[0]

										event.target.value = ""

										if (file === undefined) return

										void preparePresentationPicture(fileSource(file), new AbortController().signal).then(prepared => {
											if (prepared.ok) set({ picture: { image: prepared.image, name: file.name } })
											else toast.error(t(pictureRefusalKey(prepared.refusal)))
										})
									}}
								/>
							</Field>
						) : null}
						<label className="flex items-center justify-between gap-3 text-sm">
							{t("previewPptxDesignHideGraphics")}
							<Switch
								checked={draft.hideGraphics ?? hidden}
								onCheckedChange={hideGraphics => {
									set({ hideGraphics })
								}}
							/>
						</label>
					</FieldGroup>
					{/* Phones stack the actions as the other dialogs do: the primary one first, Cancel last. */}
					<DialogFooter className="flex-col sm:flex-row">
						<Button
							type="submit"
							disabled={pending || !editable || fill === undefined}
							className="sm:order-4"
						>
							{t("previewPptxDesignBackgroundApply")}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={pending || !editable || fill === undefined}
							className="sm:order-2 sm:me-auto"
							onClick={() => {
								apply(every(), false)
							}}
						>
							{t("previewPptxDesignBackgroundApplyAll")}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={pending || !editable}
							className="sm:order-1"
							onClick={() => {
								apply(editor?.selection ?? [], true)
							}}
						>
							{t("previewPptxDesignBackgroundReset")}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							className="sm:order-3"
							onClick={() => {
								onOpenChange(false)
							}}
						>
							{t("common:cancel")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export function BackgroundControl() {
	const { t } = useTranslation("preview")
	const editor = usePresentationEditor()?.editor
	const store = editor?.store
	const dialog = useDesignDialog(store)
	const hosted = useDesignHosted(store)

	return (
		<>
			<RibbonButton
				label={t("previewPptxDesignFormatBackground")}
				text={t("previewPptxDesignFormatBackground")}
				icon={<PaintBucketIcon />}
				disabled={editor === undefined || !editor.editable || editor.document.slides.length === 0}
				onClick={() => {
					// After the click: a ribbon popup the button sits in closes on it first (an overflow menu), and a dialog
					// opened in the same click is dismissed with it.
					requestAnimationFrame(() => {
						if (store !== undefined) openDesignDialog(store, { kind: "background" })
					})
				}}
			/>
			{hosted || dialog?.kind !== "background" ? null : (
				<BackgroundDialog
					key={dialog.key}
					open
					onOpenChange={next => {
						if (!next && store !== undefined) closeDesignDialog(store)
					}}
				/>
			)}
		</>
	)
}
