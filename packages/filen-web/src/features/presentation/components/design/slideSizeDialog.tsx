import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { RectangleHorizontalIcon } from "lucide-react"
import { SLIDE_SIZES, slideSizeOp, type SlideSizeName } from "@filen/office/core/presentation"
import { FormDialog } from "@/components/dialogs/formDialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { lengthUnit } from "@/features/preview/components/docxEditor.logic"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import {
	SIZE_LABELS,
	SIZE_NAMES,
	defaultScale,
	emuToUnit,
	slideLengthBounds,
	slideSizeName,
	typedLength,
	validSlideLength,
	type LengthUnit
} from "@/features/presentation/components/design/design.logic"
import {
	closeDesignDialog,
	openDesignDialog,
	useDesignDialog,
	useDesignHosted
} from "@/features/presentation/components/design/designDialogs"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import type { PreviewKey } from "@/lib/i18n"

// Slide Size: the presets in a menu, each opening the dialog on that size (as PowerPoint asks how content follows),
// and Custom slide size. The dialog takes width and height in the user's unit and the content's scaling: ensure fit
// (everything stays on the slide), maximize (the slide is filled) or none.

type Scale = "ensureFit" | "maximize" | "none"

const SCALES: readonly { readonly value: Scale; readonly label: PreviewKey; readonly body: PreviewKey }[] = [
	{ value: "ensureFit", label: "previewPptxDesignSizeEnsureFit", body: "previewPptxDesignSizeEnsureFitBody" },
	{ value: "maximize", label: "previewPptxDesignSizeMaximize", body: "previewPptxDesignSizeMaximizeBody" },
	{ value: "none", label: "previewPptxDesignSizeKeep", body: "previewPptxDesignSizeKeepBody" }
]

const CUSTOM = "custom"

// The lengths as shown and as applied (a preset's exact EMU; typed text read by typedLength), and the scale the user
// chose (undefined: the default for the size, defaultScale).
interface Draft {
	readonly width: string
	readonly height: string
	readonly cx: number
	readonly cy: number
	readonly type: string | undefined
	readonly scale: Scale | undefined
}

function draftFor(size: { cx: number; cy: number; type?: string }, unit: LengthUnit): Draft {
	return {
		width: emuToUnit(size.cx, unit),
		height: emuToUnit(size.cy, unit),
		cx: size.cx,
		cy: size.cy,
		type: size.type,
		scale: undefined
	}
}

export function SlideSizeDialog({
	open,
	initial,
	onOpenChange
}: {
	open: boolean
	// The size the dialog starts on (a preset chosen in the menu, or the deck's).
	initial: { cx: number; cy: number; type?: string } | undefined
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation(["preview", "common"])
	const editor = usePresentationEditor()?.editor
	const unit: LengthUnit = lengthUnit(navigator.language)
	const deckSize = editor?.document.info?.size ?? SLIDE_SIZES.widescreen
	const [draft, setDraft] = useState<Draft>(() => draftFor(initial ?? deckSize, unit))
	const [pending, setPending] = useState(false)
	// The scale the deck refused (content it cannot move or scale), until the draft changes.
	const [lockedScale, setLockedScale] = useState<Scale | undefined>(undefined)
	const { cx, cy } = draft
	const scale = draft.scale ?? defaultScale(deckSize, draft)
	const valid = validSlideLength(cx) && validSlideLength(cy)
	const preset = valid ? (slideSizeName({ cx, cy, ...(draft.type === undefined ? {} : { type: draft.type }) }) ?? CUSTOM) : CUSTOM
	const bounds = slideLengthBounds(unit)
	const presets: { value: SlideSizeName | typeof CUSTOM; label: string }[] = [
		...SIZE_NAMES.map(name => ({ value: name, label: t(SIZE_LABELS[name]) })),
		{ value: CUSTOM, label: t("previewPptxDesignSizeCustomPreset") }
	]

	return (
		<FormDialog
			open={open}
			pending={pending}
			title={t("previewPptxDesignSizeTitle")}
			description={t("previewPptxDesignSizeBody")}
			submitLabel={t("previewPptxDesignSizeApply")}
			cancelLabel={t("common:cancel")}
			canSubmit={valid && editor?.editable === true}
			onOpenChange={onOpenChange}
			onSubmit={(event: SubmitEvent) => {
				event.preventDefault()

				const op = valid ? slideSizeOp({ cx, cy, ...(draft.type === undefined ? {} : { type: draft.type }) }, scale) : undefined

				if (op === undefined || editor === undefined) return

				setPending(true)
				void editor.command(op).then(result => {
					setPending(false)

					if (result.ok) onOpenChange(false)
					else if (result.refusal === "locked" && scale !== "none") setLockedScale(scale)
				})
			}}
		>
			<FieldGroup>
				<DocxChoiceField
					label={t("previewPptxDesignSizePreset")}
					value={preset}
					items={presets}
					onChange={value => {
						if (value === CUSTOM) return

						const size = SLIDE_SIZES[value]

						setDraft(previous => ({ ...draftFor(size, unit), scale: previous.scale }))
					}}
				/>
				<div className="grid grid-cols-2 gap-3">
					<Field>
						<FieldLabel htmlFor="pptx-size-width">{t("previewPptxDesignSizeWidth", { unit })}</FieldLabel>
						<Input
							id="pptx-size-width"
							inputMode="decimal"
							value={draft.width}
							aria-invalid={!validSlideLength(cx)}
							onChange={event => {
								setDraft(previous => ({
									...previous,
									width: event.target.value,
									cx: typedLength(event.target.value, unit),
									type: undefined
								}))
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="pptx-size-height">{t("previewPptxDesignSizeHeight", { unit })}</FieldLabel>
						<Input
							id="pptx-size-height"
							inputMode="decimal"
							value={draft.height}
							aria-invalid={!validSlideLength(cy)}
							onChange={event => {
								setDraft(previous => ({
									...previous,
									height: event.target.value,
									cy: typedLength(event.target.value, unit),
									type: undefined
								}))
							}}
						/>
					</Field>
				</div>
				{valid ? null : <FieldError>{t("previewPptxDesignSizeInvalid", bounds)}</FieldError>}
				{lockedScale !== undefined && lockedScale === scale ? <FieldError>{t("previewPptxDesignSizeLocked")}</FieldError> : null}
				<Field>
					<FieldLabel id="pptx-size-scale">{t("previewPptxDesignSizeScale")}</FieldLabel>
					<RadioGroup
						aria-labelledby="pptx-size-scale"
						value={scale}
						onValueChange={value => {
							const scale = SCALES.find(entry => entry.value === value)?.value

							if (scale !== undefined) setDraft(previous => ({ ...previous, scale }))
						}}
					>
						{SCALES.map(entry => (
							<label
								key={entry.value}
								className="flex items-start gap-2"
							>
								<RadioGroupItem
									value={entry.value}
									className="mt-0.5"
								/>
								<span className="flex flex-col">
									<span className="text-sm">{t(entry.label)}</span>
									<FieldDescription>{t(entry.body)}</FieldDescription>
								</span>
							</label>
						))}
					</RadioGroup>
				</Field>
			</FieldGroup>
		</FormDialog>
	)
}

// The Slide Size menu: a preset or Custom opens the dialog on it.
export function SlideSizeControl() {
	const { t } = useTranslation("preview")
	const editor = usePresentationEditor()?.editor
	const store = editor?.store
	const focus = useCommandMenuFocus()
	const dialog = useDesignDialog(store)
	const hosted = useDesignHosted(store)
	const size = editor?.document.info?.size
	const current = size === undefined ? undefined : slideSizeName(size)
	const open = (chosen: { cx: number; cy: number; type?: string } | undefined): void => {
		focus.ran()

		if (store !== undefined) openDesignDialog(store, { kind: "size", initial: chosen })
	}

	return (
		<>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewPptxDesignSlideSize")}
					text={t("previewPptxDesignSlideSize")}
					icon={<RectangleHorizontalIcon />}
					disabled={editor?.editable !== true}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					<DropdownMenuGroup>
						{SIZE_NAMES.map(name => (
							<DropdownMenuItem
								key={name}
								aria-current={current === name ? "true" : undefined}
								className={current === name ? "bg-accent/60" : undefined}
								onClick={() => {
									open({ ...SLIDE_SIZES[name] })
								}}
							>
								{t(SIZE_LABELS[name])}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => {
							open(undefined)
						}}
					>
						{t("previewPptxDesignSizeCustom")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{hosted || dialog?.kind !== "size" ? null : (
				<SlideSizeDialog
					key={dialog.key}
					open
					initial={dialog.initial}
					onOpenChange={next => {
						if (!next && store !== undefined) closeDesignDialog(store)
					}}
				/>
			)}
		</>
	)
}
