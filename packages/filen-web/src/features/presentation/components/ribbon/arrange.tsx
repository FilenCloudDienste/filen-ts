import { useId, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
	AlignCenterHorizontalIcon,
	AlignCenterVerticalIcon,
	AlignEndHorizontalIcon,
	AlignEndVerticalIcon,
	AlignHorizontalDistributeCenterIcon,
	AlignStartHorizontalIcon,
	AlignStartVerticalIcon,
	AlignVerticalDistributeCenterIcon,
	BringToFrontIcon,
	FlipHorizontal2Icon,
	FlipVertical2Icon,
	GroupIcon,
	MousePointerClickIcon,
	RotateCcwIcon,
	RotateCwIcon,
	SendToBackIcon,
	TextQuoteIcon,
	UngroupIcon,
	type LucideIcon
} from "lucide-react"
import {
	actionOp,
	alignOp,
	altOp,
	canAlign,
	canDistribute,
	canGroup,
	canUngroup,
	canZOrder,
	distributeOp,
	canFlip,
	flipOp,
	groupOp,
	presentationHref,
	rotateOp,
	settableAction,
	ungroupOps,
	zOrderOp,
	type Action,
	type AlignEdge,
	type AlignTarget,
	type DeckOp,
	type DistributeAxis,
	type SlideRef,
	type ZOrder
} from "@filen/office/core/presentation"
import {
	ShapeEditLayer,
	selectedShapes,
	slideShapes,
	useShapeSelection,
	type ShapeEditLabels,
	type SlideShape
} from "@filen/office/react/presentation"
import type { ShapeRef } from "@filen/office/core/presentation"
import { FormDialog } from "@/components/dialogs/formDialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { useRibbonDialog, type RibbonDialogRender } from "@/features/presentation/components/ribbon/ribbonDialogs"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { usePresentationObjectBindings } from "@/features/presentation/lib/keymap/objects"
import { usePresentationTextBindings } from "@/features/presentation/lib/keymap/text"
import type { PreviewKey } from "@/lib/i18n"

// The Arrange tab: stacking order, group and ungroup, align and distribute, rotate and flip, and the selected
// object's alt text and click action. Every command acts on the shapes selected on the slide in view (the canvas's
// selection store) and runs through the editor's session as one op. The canvas layer (PresentationShapeLayer) is
// wired here too, so the shell mounts it in SlideView's overlay slot with the same bindings and labels.

const BUTTON = 30
const MENU = 44

// ---- the canvas -------------------------------------------------------------------------------------------------

const ROLE_KEYS: Readonly<Record<SlideShape["role"], PreviewKey>> = {
	master: "previewPptxObjectShape",
	layout: "previewPptxObjectShape",
	placeholder: "previewPptxObjectPlaceholder",
	shape: "previewPptxObjectShape",
	picture: "previewPptxObjectPicture",
	table: "previewPptxObjectTable",
	chart: "previewPptxObjectChart",
	smartart: "previewPptxObjectSmartArt",
	media: "previewPptxObjectMedia",
	ole: "previewPptxObjectEmbedded",
	ink: "previewPptxObjectInk",
	group: "previewPptxObjectGroup"
}

// What an object is called: a medium by what it plays (a .pptx holds one as a picture), else by its role.
function objectKey(shape: SlideShape): PreviewKey {
	if (shape.media !== undefined) return shape.media.kind === "audio" ? "previewPptxObjectAudio" : "previewPptxObjectVideo"

	return ROLE_KEYS[shape.role]
}

export function shapeEditLabels(t: TFunction<"preview">): ShapeEditLabels {
	return {
		canvas: t("previewPptxCanvasLabel"),
		keys: t("previewPptxCanvasKeys"),
		describe: shapes => {
			const only = shapes.length === 1 ? shapes[0] : undefined

			if (only === undefined) return shapes.length === 0 ? "" : t("previewPptxSelectedMany", { count: shapes.length })

			const name = t(objectKey(only))
			const alt = only.alt?.decorative === true ? undefined : (only.alt?.descr ?? only.alt?.title)

			return alt === undefined || alt === "" ? t("previewPptxSelectedOne", { name }) : t("previewPptxSelectedNamed", { name, alt })
		}
	}
}

// The selection layer over the slide in view, for SlideView's overlay slot.
export function PresentationShapeLayer({
	editor,
	scale,
	onEnterText
}: {
	editor: PresentationRibbonEditor
	// Screen px per slide px (SlideView's onScale).
	scale: number
	onEnterText?: (shape: ShapeRef, at?: { readonly x: number; readonly y: number }, options?: { readonly selectAll?: boolean }) => void
}) {
	const { t } = useTranslation("preview")
	const bindings = usePresentationObjectBindings()
	const textBindings = usePresentationTextBindings()

	return (
		<ShapeEditLayer
			render={editor.render}
			size={editor.info.size}
			{...(editor.info.grid === undefined ? {} : { grid: editor.info.grid })}
			scale={scale}
			selection={editor.selection}
			editable={editor.info.editable}
			bindings={bindings}
			labels={shapeEditLabels(t)}
			command={op => editor.command(op)}
			{...(onEnterText === undefined ? {} : { onEnterText })}
			{...(editor.text === undefined ? {} : { text: { editing: editor.text, session: editor.session, bindings: textBindings } })}
		/>
	)
}

// ---- shared ------------------------------------------------------------------------------------------------------

// Group (or Ungroup every selected group, one op: one undo step, all or nothing) on the selection, the ribbon's and
// the canvas menu's: the shapes the op makes are selected once its render arrives.
export function runGrouping(
	editor: PresentationRibbonEditor,
	slide: SlideRef,
	selected: readonly SlideShape[],
	order: readonly number[],
	kind: "group" | "ungroup"
): void {
	const op =
		kind === "group"
			? groupOp(
					slide,
					selected.map(shape => shape.id)
				)
			: ungroupOps(slide, selected)[0]

	if (op === undefined) return

	const withdraw = editor.selection.selectNew(slide, order)

	void editor.command(op).then(result => {
		if (!result.ok) withdraw()
	})
}

// The Alt Text and Action dialogs on one shape, for useRibbonDialog's open.
export function altTextDialog(shape: SlideShape, slide: SlideRef): RibbonDialogRender {
	return (live, close) => (
		<AltTextDialog
			shape={shape}
			slide={slide}
			run={op => {
				void live.command(op)
			}}
			onClose={close}
		/>
	)
}

export function actionDialog(shape: SlideShape, slide: SlideRef): RibbonDialogRender {
	return (live, close) => (
		<ActionDialog
			shape={shape}
			slide={slide}
			editor={live}
			onClose={close}
		/>
	)
}

// The selected shapes of the slide in view and the commands' common inputs.
export function useArrange(editor: PresentationRibbonEditor): {
	readonly slide: SlideRef | undefined
	readonly selected: readonly SlideShape[]
	readonly ids: readonly number[]
	readonly order: readonly number[]
	readonly run: (op: DeckOp | undefined) => void
} {
	const state = useShapeSelection(editor.selection)
	const selected = selectedShapes(editor.render, state)

	return {
		slide: editor.render?.ref,
		selected,
		ids: selected.map(shape => shape.id),
		order: slideShapes(editor.render).map(shape => shape.id),
		run: op => {
			if (op !== undefined) void editor.command(op)
		}
	}
}

function MenuItem({ icon: Icon, label, disabled, onClick }: { icon: LucideIcon; label: string; disabled: boolean; onClick: () => void }) {
	return (
		<DropdownMenuItem
			disabled={disabled}
			onClick={onClick}
		>
			<Icon />
			{label}
		</DropdownMenuItem>
	)
}

// ---- order -------------------------------------------------------------------------------------------------------

const Z_ITEMS: readonly { readonly to: ZOrder; readonly label: PreviewKey; readonly icon: LucideIcon }[] = [
	{ to: "forward", label: "previewPptxBringForward", icon: BringToFrontIcon },
	{ to: "front", label: "previewPptxBringToFront", icon: BringToFrontIcon },
	{ to: "backward", label: "previewPptxSendBackward", icon: SendToBackIcon },
	{ to: "back", label: "previewPptxSendToBack", icon: SendToBackIcon }
]

function ZOrderMenu({
	editor,
	items,
	label,
	icon
}: {
	editor: PresentationRibbonEditor
	items: typeof Z_ITEMS
	label: PreviewKey
	icon: ReactNode
}) {
	const { t } = useTranslation("preview")
	const { slide, ids, order, run } = useArrange(editor)
	const focus = useCommandMenuFocus()
	const chosen = new Set(ids)

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t(label)}
				icon={icon}
				disabled={slide === undefined || items.every(item => !canZOrder(order, chosen, item.to))}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				{items.map(item => (
					<MenuItem
						key={item.to}
						icon={item.icon}
						label={t(item.label)}
						disabled={!canZOrder(order, chosen, item.to)}
						onClick={() => {
							focus.ran()

							if (slide !== undefined) run(zOrderOp(slide, ids, item.to))
						}}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function OrderControls({ editor }: { editor: PresentationRibbonEditor }) {
	return (
		<>
			<ZOrderMenu
				editor={editor}
				items={Z_ITEMS.slice(0, 2)}
				label="previewPptxBringForward"
				icon={<BringToFrontIcon />}
			/>
			<ZOrderMenu
				editor={editor}
				items={Z_ITEMS.slice(2)}
				label="previewPptxSendBackward"
				icon={<SendToBackIcon />}
			/>
		</>
	)
}

// ---- group -------------------------------------------------------------------------------------------------------

function GroupControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { slide, selected, order } = useArrange(editor)

	return (
		<>
			<RibbonButton
				label={t("previewPptxGroup")}
				icon={<GroupIcon />}
				disabled={slide === undefined || !canGroup(selected)}
				onClick={() => {
					if (slide !== undefined) runGrouping(editor, slide, selected, order, "group")
				}}
			/>
			<RibbonButton
				label={t("previewPptxUngroup")}
				icon={<UngroupIcon />}
				disabled={slide === undefined || !canUngroup(selected)}
				onClick={() => {
					if (slide !== undefined) runGrouping(editor, slide, selected, order, "ungroup")
				}}
			/>
		</>
	)
}

// ---- align -------------------------------------------------------------------------------------------------------

const ALIGN_ITEMS: readonly { readonly edge: AlignEdge; readonly label: PreviewKey; readonly icon: LucideIcon }[] = [
	{ edge: "left", label: "previewPptxAlignLeft", icon: AlignStartVerticalIcon },
	{ edge: "center", label: "previewPptxAlignCenter", icon: AlignCenterVerticalIcon },
	{ edge: "right", label: "previewPptxAlignRight", icon: AlignEndVerticalIcon },
	{ edge: "top", label: "previewPptxAlignTop", icon: AlignStartHorizontalIcon },
	{ edge: "middle", label: "previewPptxAlignMiddle", icon: AlignCenterHorizontalIcon },
	{ edge: "bottom", label: "previewPptxAlignBottom", icon: AlignEndHorizontalIcon }
]

const DISTRIBUTE_ITEMS: readonly { readonly axis: DistributeAxis; readonly label: PreviewKey; readonly icon: LucideIcon }[] = [
	{ axis: "horizontal", label: "previewPptxDistributeHorizontally", icon: AlignHorizontalDistributeCenterIcon },
	{ axis: "vertical", label: "previewPptxDistributeVertically", icon: AlignVerticalDistributeCenterIcon }
]

function AlignControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { slide, selected, run } = useArrange(editor)
	// Shapes the file locks against moving stay where they are (ECMA-376 noMove, as PowerPoint keeps them).
	const ids = selected.filter(shape => shape.locks?.noMove !== true).map(shape => shape.id)
	const [target, setTarget] = useState<AlignTarget>("selection")
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxArrangeAlign")}
				icon={<AlignStartVerticalIcon />}
				disabled={slide === undefined || !canAlign(ids.length)}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				{ALIGN_ITEMS.map(item => (
					<MenuItem
						key={item.edge}
						icon={item.icon}
						label={t(item.label)}
						disabled={!canAlign(ids.length)}
						onClick={() => {
							focus.ran()

							if (slide !== undefined) run(alignOp(slide, ids, item.edge, target))
						}}
					/>
				))}
				<DropdownMenuSeparator />
				{DISTRIBUTE_ITEMS.map(item => (
					<MenuItem
						key={item.axis}
						icon={item.icon}
						label={t(item.label)}
						disabled={!canDistribute(ids.length, target)}
						onClick={() => {
							focus.ran()

							if (slide !== undefined) run(distributeOp(slide, ids, item.axis, target))
						}}
					/>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={target}
					onValueChange={(value: AlignTarget) => {
						setTarget(value)
					}}
				>
					<DropdownMenuRadioItem value="slide">{t("previewPptxAlignToSlide")}</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="selection">{t("previewPptxAlignToSelection")}</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// ---- rotate ------------------------------------------------------------------------------------------------------

function RotateControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { slide, selected, run } = useArrange(editor)
	const focus = useCommandMenuFocus()
	const off = slide === undefined || selected.length === 0
	// A graphic frame (table, chart, object, medium, diagram) has no flip either format draws.
	const unflippable = !off && !selected.every(canFlip)
	const item = (icon: LucideIcon, label: PreviewKey, op: () => DeckOp | undefined, disabled = off) => (
		<MenuItem
			icon={icon}
			label={t(label)}
			disabled={disabled}
			onClick={() => {
				focus.ran()
				run(op())
			}}
		/>
	)

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxArrangeRotate")}
				icon={<RotateCwIcon />}
				disabled={off}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				{slide === undefined ? null : (
					<>
						{item(RotateCwIcon, "previewPptxRotateRight", () => rotateOp(slide, selected, 1))}
						{item(RotateCcwIcon, "previewPptxRotateLeft", () => rotateOp(slide, selected, -1))}
						{item(FlipVertical2Icon, "previewPptxFlipVertical", () => flipOp(slide, selected, "vertical"), off || unflippable)}
						{item(
							FlipHorizontal2Icon,
							"previewPptxFlipHorizontal",
							() => flipOp(slide, selected, "horizontal"),
							off || unflippable
						)}
						{unflippable ? (
							<DropdownMenuGroup>
								<DropdownMenuLabel className="max-w-64 text-xs font-normal text-muted-foreground">
									{t("previewPptxFlipFrames")}
								</DropdownMenuLabel>
							</DropdownMenuGroup>
						) : null}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// ---- alt text ----------------------------------------------------------------------------------------------------

export function AltTextDialog({
	shape,
	slide,
	onClose,
	run
}: {
	shape: SlideShape
	slide: SlideRef
	onClose: () => void
	run: (op: DeckOp) => void
}) {
	const { t } = useTranslation("preview")
	const [descr, setDescr] = useState(shape.alt?.descr ?? "")
	const [title, setTitle] = useState(shape.alt?.title ?? "")
	const [decorative, setDecorative] = useState(shape.alt?.decorative === true)
	const descrId = useId()
	const titleId = useId()
	const decorativeId = useId()

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxAltTextTitle")}
			description={t("previewPptxAltTextDescription")}
			submitLabel={t("previewPptxArrangeApply")}
			cancelLabel={t("previewPptxArrangeCancel")}
			canSubmit
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()
				run(altOp({ slide, id: shape.id }, { descr, title, decorative }))
				onClose()
			}}
		>
			<Field>
				<FieldLabel htmlFor={descrId}>{t("previewPptxAltTextLabel")}</FieldLabel>
				<Input
					id={descrId}
					value={decorative ? "" : descr}
					disabled={decorative}
					maxLength={4096}
					onChange={event => {
						setDescr(event.target.value)
					}}
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor={titleId}>{t("previewPptxAltTextTitleLabel")}</FieldLabel>
				<Input
					id={titleId}
					value={title}
					maxLength={1024}
					onChange={event => {
						setTitle(event.target.value)
					}}
				/>
			</Field>
			<Field orientation="horizontal">
				<Switch
					id={decorativeId}
					checked={decorative}
					onCheckedChange={checked => {
						setDecorative(checked)
					}}
				/>
				<Label htmlFor={decorativeId}>{t("previewPptxAltTextDecorative")}</Label>
			</Field>
		</FormDialog>
	)
}

// ---- action ------------------------------------------------------------------------------------------------------

type ActionChoice =
	"keep" | "none" | "next" | "previous" | "first" | "last" | "lastViewed" | "end" | "slide" | "url" | "customShow" | "media"

const JUMPS: readonly { readonly value: ActionChoice & Extract<Action, { kind: "internal" }>["jump"]; readonly label: PreviewKey }[] = [
	{ value: "next", label: "previewPptxActionNext" },
	{ value: "previous", label: "previewPptxActionPrevious" },
	{ value: "first", label: "previewPptxActionFirst" },
	{ value: "last", label: "previewPptxActionLast" },
	{ value: "lastViewed", label: "previewPptxActionLastViewed" },
	{ value: "end", label: "previewPptxActionEnd" }
]

const REFUSED_KEYS: Readonly<Record<Extract<Action, { kind: "refused" }>["what"], PreviewKey>> = {
	program: "previewPptxActionRefusedProgram",
	macro: "previewPptxActionRefusedMacro",
	ole: "previewPptxActionRefusedOle",
	file: "previewPptxActionRefusedFile",
	script: "previewPptxActionRefusedScript",
	execute: "previewPptxActionRefusedExecute",
	scheme: "previewPptxActionRefusedScheme"
}

function choiceOf(action: Action | undefined): ActionChoice {
	if (action === undefined) return "none"

	switch (action.kind) {
		case "internal":
			return action.jump
		case "slide":
		case "url":
		case "customShow":
		case "media":
			return action.kind
		case "refused":
			return "keep"
	}
}

// The action the dialog's fields make; undefined: none; null: not valid yet.
export function actionOfChoice(
	choice: ActionChoice,
	fields: { readonly slide: string; readonly url: string; readonly show: string; readonly returnAfter: boolean },
	slides: readonly SlideRef[]
): Action | undefined | null {
	switch (choice) {
		case "keep":
			return null
		case "none":
			return undefined
		case "slide": {
			const slide = slides.find(ref => String(ref) === fields.slide)

			return slide === undefined ? null : { kind: "slide", slide }
		}
		case "url": {
			// Stored as the save reads it back (spaces percent-encoded); anything else is not a link the deck can carry.
			const href = presentationHref(fields.url)

			return href === undefined ? null : { kind: "url", href }
		}
		case "customShow": {
			const id = Number(fields.show)

			return fields.show === "" || !Number.isInteger(id) ? null : { kind: "customShow", id, returnAfter: fields.returnAfter }
		}
		case "media":
			return { kind: "media" }
		default:
			return { kind: "internal", jump: choice }
	}
}

export function ActionDialog({
	shape,
	slide,
	editor,
	onClose
}: {
	shape: SlideShape
	slide: SlideRef
	editor: PresentationRibbonEditor
	onClose: () => void
}) {
	const { t } = useTranslation("preview")
	const [trigger, setTrigger] = useState<"click" | "hover">("click")
	const current = shape.actions?.[trigger]
	const [choice, setChoice] = useState<ActionChoice>(choiceOf(current))
	const [slideValue, setSlideValue] = useState(
		current?.kind === "slide" ? String(current.slide) : String(editor.info.slides[0]?.ref ?? "")
	)
	const [url, setUrl] = useState(current?.kind === "url" ? current.href : "")
	const [show, setShow] = useState(current?.kind === "customShow" ? String(current.id) : String(editor.info.customShows[0]?.id ?? ""))
	const [returnAfter, setReturnAfter] = useState(current?.kind === "customShow" ? current.returnAfter : false)
	const urlId = useId()
	const returnId = useId()
	const slides = editor.info.slides.map(entry => entry.ref)
	const refused = current?.kind === "refused" ? current : undefined
	const action = actionOfChoice(choice, { slide: slideValue, url, show, returnAfter }, slides)
	const urlInvalid = choice === "url" && url.trim() !== "" && action === null
	const choices: { value: ActionChoice; label: string }[] = [
		...(refused === undefined ? [] : [{ value: "keep" as const, label: t("previewPptxActionKeep") }]),
		{ value: "none", label: t("previewPptxActionNone") },
		...JUMPS.map(jump => ({ value: jump.value, label: t(jump.label) })),
		{ value: "slide", label: t("previewPptxActionSlide") },
		{ value: "url", label: t("previewPptxActionUrl") },
		...(editor.info.customShows.length === 0 ? [] : [{ value: "customShow" as const, label: t("previewPptxActionCustomShow") }]),
		...(shape.role === "media" || current?.kind === "media"
			? [{ value: "media" as const, label: t("previewPptxActionPlayMedia") }]
			: [])
	]

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxActionTitle")}
			description={t("previewPptxActionDescription")}
			submitLabel={t("previewPptxArrangeApply")}
			cancelLabel={t("previewPptxArrangeCancel")}
			canSubmit={choice === "keep" || action !== null}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (choice !== "keep" && action !== null && (action === undefined || settableAction(action))) {
					const op = actionOp({ slide, id: shape.id }, trigger, action)

					if (op !== undefined) void editor.command(op)
				}

				onClose()
			}}
		>
			<DocxChoiceField
				label={t("previewPptxActionTrigger")}
				value={trigger}
				items={[
					{ value: "click", label: t("previewPptxActionOnClick") },
					{ value: "hover", label: t("previewPptxActionOnHover") }
				]}
				onChange={next => {
					const now = shape.actions?.[next]

					setTrigger(next)
					setChoice(choiceOf(now))
					setUrl(now?.kind === "url" ? now.href : "")
				}}
			/>
			{refused === undefined ? null : (
				<p className="text-sm text-muted-foreground">
					{t("previewPptxActionRefusedKept", { what: t(REFUSED_KEYS[refused.what]) })}
				</p>
			)}
			<DocxChoiceField
				label={t("previewPptxActionKind")}
				value={choice}
				items={choices}
				onChange={setChoice}
			/>
			{choice === "slide" ? (
				<DocxChoiceField
					label={t("previewPptxActionSlideLabel")}
					value={slideValue}
					items={slides.map((ref, index) => ({
						value: String(ref),
						label: t("previewPptxActionSlideNumber", { number: index + 1 })
					}))}
					onChange={setSlideValue}
				/>
			) : null}
			{choice === "url" ? (
				<Field data-invalid={urlInvalid || undefined}>
					<FieldLabel htmlFor={urlId}>{t("previewPptxActionUrlLabel")}</FieldLabel>
					<Input
						id={urlId}
						type="url"
						inputMode="url"
						value={url}
						maxLength={2048}
						aria-invalid={urlInvalid || undefined}
						onChange={event => {
							setUrl(event.target.value)
						}}
					/>
					{urlInvalid ? <FieldError>{t("previewPptxActionUrlInvalid")}</FieldError> : null}
				</Field>
			) : null}
			{choice === "customShow" ? (
				<>
					<DocxChoiceField
						label={t("previewPptxActionCustomShowLabel")}
						value={show}
						items={editor.info.customShows.map(entry => ({ value: String(entry.id), label: entry.name }))}
						onChange={setShow}
					/>
					<Field orientation="horizontal">
						<Switch
							id={returnId}
							checked={returnAfter}
							onCheckedChange={checked => {
								setReturnAfter(checked)
							}}
						/>
						<Label htmlFor={returnId}>{t("previewPptxActionReturn")}</Label>
					</Field>
				</>
			) : null}
		</FormDialog>
	)
}

function ObjectControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { slide, selected } = useArrange(editor)
	const dialog = useRibbonDialog(editor)
	const only = selected.length === 1 ? selected[0] : undefined

	return (
		<>
			<RibbonButton
				label={t("previewPptxAltText")}
				icon={<TextQuoteIcon />}
				disabled={only === undefined}
				onClick={() => {
					if (only !== undefined && slide !== undefined) dialog.open(altTextDialog(only, slide))
				}}
			/>
			<RibbonButton
				label={t("previewPptxAction")}
				icon={<MousePointerClickIcon />}
				disabled={only === undefined}
				onClick={() => {
					if (only !== undefined && slide !== undefined) dialog.open(actionDialog(only, slide))
				}}
			/>
			{dialog.view}
		</>
	)
}

// ---- the groups --------------------------------------------------------------------------------------------------

export const arrangeGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	const t = context.t

	return [
		{
			id: "order",
			label: t("previewPptxArrangeOrder", { ns: "preview" }),
			icon: BringToFrontIcon,
			width: 2 * MENU,
			priority: 4,
			content: <OrderControls editor={editor} />
		},
		{
			id: "group",
			label: t("previewPptxArrangeGroup", { ns: "preview" }),
			icon: GroupIcon,
			width: 2 * BUTTON,
			priority: 3,
			content: <GroupControls editor={editor} />
		},
		{
			id: "align",
			label: t("previewPptxArrangeAlign", { ns: "preview" }),
			icon: AlignStartVerticalIcon,
			width: MENU,
			priority: 5,
			single: true,
			content: <AlignControls editor={editor} />
		},
		{
			id: "rotate",
			label: t("previewPptxArrangeRotate", { ns: "preview" }),
			icon: RotateCwIcon,
			width: MENU,
			priority: 2,
			single: true,
			content: <RotateControls editor={editor} />
		},
		{
			id: "object",
			label: t("previewPptxArrangeObject", { ns: "preview" }),
			icon: TextQuoteIcon,
			width: 2 * BUTTON,
			priority: 1,
			content: <ObjectControls editor={editor} />
		}
	]
}
