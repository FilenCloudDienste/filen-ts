import { useEffect, useId, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	AArrowDownIcon,
	AArrowUpIcon,
	AlignCenterIcon,
	AlignJustifyIcon,
	AlignLeftIcon,
	AlignRightIcon,
	AlignVerticalSpaceAroundIcon,
	BaselineIcon,
	BoldIcon,
	Columns2Icon,
	HighlighterIcon,
	IndentDecreaseIcon,
	IndentIncreaseIcon,
	ItalicIcon,
	LinkIcon,
	ListIcon,
	ListOrderedIcon,
	ListChevronsUpDownIcon,
	PilcrowLeftIcon,
	RemoveFormattingIcon,
	StrikethroughIcon,
	SubscriptIcon,
	SuperscriptIcon,
	TextCursorInputIcon,
	TypeIcon,
	UnderlineIcon
} from "lucide-react"
import { DOCX_COMMON_FONTS } from "@filen/office/core/docx/edit"
import {
	FONT_SIZES,
	changeLevel,
	clearFormatting,
	setBullet,
	setHyperlink,
	setParaProps,
	setRunProps,
	stepFontSize,
	toggleBaseline,
	toggleRunFlag,
	toggleStrike,
	toggleUnderline,
	type Bullet,
	type ParaPatch,
	type ParaProps,
	type RunProps,
	type ShapeRef,
	type TextCommand,
	type TextDefaults
} from "@filen/office/core/presentation"
import { formatShapes, selectedShapes, useShapeSelection, useTextEditing } from "@filen/office/react/presentation"
import { cn } from "@filen/shared"
import { FormDialog } from "@/components/dialogs/formDialog"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DocxColorGrid } from "@/features/office/components/officeColorGrid"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { STANDARD_SWATCHES } from "@/features/office/lib/officeControls"
import { CHARACTER_SPACINGS, HIGHLIGHT_SWATCHES } from "@/features/preview/components/docxEditor.logic"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { DocxColorButton } from "@/features/preview/components/docxFormatControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import {
	ANCHORS,
	BULLETS,
	CASES,
	DIRECTIONS,
	LINE_SPACINGS,
	MIXED,
	NUMBERINGS,
	TEXT_ROLES,
	THEME_FONTS,
	UNDERLINES,
	linkOfChoice,
	solidRgb,
	spcOf,
	type TextRibbonEditor,
	type TextTarget
} from "@/features/presentation/components/ribbon/homeText.logic"
import type { PreviewKey } from "@/lib/i18n"
import { i18n } from "@/lib/i18n"

// The Home tab's Font and Paragraph groups of the presentation editor: every a:rPr and a:pPr property a user sets in
// PowerPoint's ribbon, and the body properties of the box (direction, anchoring, columns). With a body open the
// commands act on its selection (the text editor's controller; focus stays in the body); with shapes selected and no
// body open they format those shapes' whole text, one command each. What a control shows comes from the open body's
// format (the selection's properties as the inheritance chain shows them).

function useTextTarget(editor: TextRibbonEditor, editable: boolean): TextTarget {
	const controller = useTextEditing(editor.text)
	const state = useShapeSelection(editor.selection)
	const slide = state.slide
	const shapes: ShapeRef[] =
		slide === undefined
			? []
			: selectedShapes(editor.render, state)
					.filter(shape => TEXT_ROLES.has(shape.role))
					.map(shape => ({ slide, id: shape.id }))
	const format = controller?.format()

	return {
		enabled: editable && (controller !== undefined || shapes.length > 0),
		formatted: format !== undefined,
		run: format?.run ?? {},
		paragraph: format?.paragraph ?? {},
		bodyPr: format?.bodyPr ?? {},
		apply: make => {
			if (controller !== undefined) {
				controller.run(make(controller.defaults))

				return
			}

			void formatShapes(editor.session, shapes, make)
		},
		setBodyPr: patch => {
			if (controller !== undefined) {
				controller.setBodyPr(patch)

				return
			}

			void (async () => {
				for (const shape of shapes) {
					const seed = await editor.session.textSeed(shape).catch(() => undefined)

					if (seed !== undefined) {
						await editor.command({
							family: "text",
							kind: "setText",
							target: shape,
							body: { ...seed.body, bodyPr: { ...seed.body.bodyPr, ...patch } }
						})
					}
				}
			})()
		}
	}
}

// ---- Font -------------------------------------------------------------------------------------------------------

function FontPicker({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const current = target.run.latin?.typeface
	const known = current === undefined || THEME_FONTS.some(font => font.value === current) || DOCX_COMMON_FONTS.includes(current)
	const items = [
		...THEME_FONTS.map(font => ({ value: font.value, label: t(font.label) })),
		...DOCX_COMMON_FONTS.map(name => ({ value: name, label: name })),
		...(known ? [] : [{ value: current, label: current }]),
		...(current === undefined ? [{ value: MIXED, label: target.formatted ? t("previewPptxTextFontMixed") : "" }] : [])
	]

	return (
		<Select
			items={items}
			value={current ?? MIXED}
			disabled={!target.enabled}
			onOpenChange={focus.opened}
			onOpenChangeComplete={focus.settled}
			onValueChange={next => {
				if (typeof next === "string" && next !== MIXED)
					target.apply(defaults => setRunProps({ latin: { typeface: next } }, defaults))
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label={t("previewDocxFont")}
				className="w-32 shrink-0"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent
				data-preview-surface
				className="max-h-80 min-w-48"
			>
				<SelectGroup>
					<SelectLabel>{t("previewDocxFontsTheme")}</SelectLabel>
					{THEME_FONTS.map(font => (
						<SelectItem
							key={font.value}
							value={font.value}
						>
							{t(font.label)}
						</SelectItem>
					))}
				</SelectGroup>
				<SelectGroup>
					<SelectLabel>{t("previewDocxFontsCommon")}</SelectLabel>
					{DOCX_COMMON_FONTS.map(name => (
						<SelectItem
							key={name}
							value={name}
						>
							{name}
						</SelectItem>
					))}
					{known ? null : <SelectItem value={current}>{current}</SelectItem>}
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}

function points(sz: number): string {
	return i18n.format(sz / 100, "number")
}

function SizePicker({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const sz = target.run.sz
	const sizes = FONT_SIZES.map(size => Math.round(size * 100))
	const list = sz === undefined || sizes.includes(sz) ? sizes : [...sizes, sz].sort((a, b) => a - b)
	const items = [
		...list.map(size => ({ value: String(size), label: points(size) })),
		...(sz === undefined ? [{ value: MIXED, label: "" }] : [])
	]

	return (
		<Select
			items={items}
			value={sz === undefined ? MIXED : String(sz)}
			disabled={!target.enabled}
			onOpenChange={focus.opened}
			onOpenChangeComplete={focus.settled}
			onValueChange={next => {
				if (typeof next === "string" && next !== MIXED) target.apply(defaults => setRunProps({ sz: Number(next) }, defaults))
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label={t("previewDocxFontSize")}
				className="w-16 shrink-0"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent
				data-preview-surface
				className="max-h-80"
			>
				<SelectGroup>
					{list.map(size => (
						<SelectItem
							key={size}
							value={String(size)}
						>
							{points(size)}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}

function UnderlineMenu({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxTextUnderlineStyle")}
				icon={<UnderlineIcon />}
				disabled={!target.enabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="max-h-80"
			>
				<DropdownMenuRadioGroup
					value={target.run.u ?? ""}
					onValueChange={value => {
						focus.ran()
						target.apply(defaults => setRunProps({ u: value as NonNullable<RunProps["u"]> }, defaults))
					}}
				>
					{UNDERLINES.map(item => (
						<DropdownMenuRadioItem
							key={item.value}
							value={item.value}
						>
							{t(item.label)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function MoreFormatsMenu({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const spc = target.run.spc ?? 0

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxTextMoreFormats")}
				icon={<TypeIcon />}
				disabled={!target.enabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuCheckboxItem
					checked={target.run.strike === "dblStrike"}
					onCheckedChange={() => {
						focus.ran()
						target.apply(defaults => toggleStrike(defaults, "dblStrike"))
					}}
				>
					{t("previewDocxDoubleStrikethrough")}
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={target.run.cap ?? "none"}
					onValueChange={value => {
						focus.ran()
						target.apply(defaults => setRunProps({ cap: value as NonNullable<RunProps["cap"]> }, defaults))
					}}
				>
					<DropdownMenuLabel>{t("previewPptxTextCase")}</DropdownMenuLabel>
					{CASES.map(item => (
						<DropdownMenuRadioItem
							key={item.value}
							value={item.value}
						>
							{t(item.label)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={String(spc)}
					onValueChange={value => {
						focus.ran()

						const next = Number(value)

						target.apply(defaults => setRunProps({ spc: next === 0 ? null : next }, defaults))
					}}
				>
					<DropdownMenuLabel>{t("previewPptxTextCharacterSpacing")}</DropdownMenuLabel>
					{CHARACTER_SPACINGS.map(item => (
						<DropdownMenuRadioItem
							key={item.twips}
							value={String(spcOf(item.twips))}
						>
							{t(item.label)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function FontColor({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const rgb = solidRgb(target.run.fill)

	return (
		<DocxColorButton
			label={t("previewDocxFontColor")}
			icon={<BaselineIcon />}
			rgb={rgb}
			disabled={!target.enabled}
		>
			{close => (
				<DocxColorGrid
					theme={[]}
					standard={STANDARD_SWATCHES}
					chosen={rgb ?? "auto"}
					none={{ label: t("previewOfficeColorAutomatic"), key: "auto" }}
					onPick={swatch => {
						close()
						target.apply(defaults =>
							setRunProps(
								{ fill: swatch === null ? null : { kind: "solid", color: { kind: "srgb", rgb: swatch.rgb } } },
								defaults
							)
						)
					}}
				/>
			)}
		</DocxColorButton>
	)
}

function Highlight({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const rgb = solidRgb(target.run.highlight)
	const swatches = HIGHLIGHT_SWATCHES.map(swatch => ({
		key: swatch.rgb,
		rgb: swatch.rgb,
		label: { name: swatch.label },
		color: { kind: "rgb" as const, value: swatch.rgb }
	}))

	return (
		<DocxColorButton
			label={t("previewDocxHighlightColor")}
			icon={<HighlighterIcon />}
			rgb={rgb}
			disabled={!target.enabled}
		>
			{close => (
				<DocxColorGrid
					theme={[]}
					standard={swatches}
					chosen={rgb ?? "none"}
					none={{ label: t("previewOfficeColorNone"), key: "none" }}
					onPick={swatch => {
						close()
						target.apply(defaults =>
							setRunProps({ highlight: swatch === null ? null : { kind: "srgb", rgb: swatch.rgb } }, defaults)
						)
					}}
				/>
			)}
		</DocxColorButton>
	)
}

function FontControls({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const run = target.run
	const disabled = !target.enabled
	const toggle = (label: PreviewKey, icon: ReactNode, pressed: boolean, make: (defaults: TextDefaults) => TextCommand) => (
		<RibbonButton
			label={t(label)}
			icon={icon}
			pressed={pressed}
			disabled={disabled}
			onClick={() => {
				target.apply(make)
			}}
		/>
	)

	return (
		<>
			<FontPicker target={target} />
			<SizePicker target={target} />
			{toggle("previewDocxFontGrow", <AArrowUpIcon />, false, defaults => stepFontSize(1, defaults))}
			{toggle("previewDocxFontShrink", <AArrowDownIcon />, false, defaults => stepFontSize(-1, defaults))}
			{toggle("previewDocxBold", <BoldIcon />, run.b === true, defaults => toggleRunFlag("b", defaults))}
			{toggle("previewDocxItalic", <ItalicIcon />, run.i === true, defaults => toggleRunFlag("i", defaults))}
			{toggle("previewDocxUnderline", <UnderlineIcon />, run.u !== undefined && run.u !== "none", defaults =>
				toggleUnderline(defaults)
			)}
			<UnderlineMenu target={target} />
			{toggle("previewDocxStrikethrough", <StrikethroughIcon />, run.strike === "sngStrike", defaults => toggleStrike(defaults))}
			{toggle("previewDocxSuperscript", <SuperscriptIcon />, (run.baseline ?? 0) > 0, defaults => toggleBaseline("super", defaults))}
			{toggle("previewDocxSubscript", <SubscriptIcon />, (run.baseline ?? 0) < 0, defaults => toggleBaseline("sub", defaults))}
			<MoreFormatsMenu target={target} />
			<FontColor target={target} />
			<Highlight target={target} />
			{toggle("previewDocxClearFormatting", <RemoveFormattingIcon />, false, defaults => clearFormatting(defaults))}
		</>
	)
}

// ---- Paragraph ---------------------------------------------------------------------------------------------------

function ListMenu({ target, kind }: { target: TextTarget; kind: "bullets" | "numbering" }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const shown = target.paragraph.bullet
	const bullets = kind === "bullets"
	const on = shown !== undefined && (bullets ? shown.kind === "char" || shown.kind === "blip" : shown.kind === "autoNum")
	const label = bullets ? "previewDocxBulletList" : "previewDocxNumberedList"
	const items = bullets
		? BULLETS.map(item => ({ key: item.label, label: t(item.label), bullet: item.bullet, font: item.font }))
		: NUMBERINGS.map(item => ({
				key: item.label,
				label: t(item.label),
				bullet: { kind: "autoNum", scheme: item.scheme } satisfies Bullet,
				font: undefined
			}))

	return (
		<>
			<RibbonButton
				label={t(label)}
				icon={bullets ? <ListIcon /> : <ListOrderedIcon />}
				pressed={on}
				disabled={!target.enabled}
				onClick={() => {
					const first = items[0]

					if (first !== undefined) target.apply(defaults => setBullet(first.bullet, defaults, first.font))
				}}
			/>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t(label)}
					icon={null}
					disabled={!target.enabled}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					<DropdownMenuItem
						onClick={() => {
							focus.ran()
							target.apply(defaults => setParaProps({ bullet: { kind: "none" } }, defaults))
						}}
					>
						{t(bullets ? "previewPptxTextBulletNone" : "previewPptxTextNumberNone")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					{items.map(item => (
						<DropdownMenuItem
							key={item.key}
							className={cn(shown !== undefined && JSON.stringify(shown) === JSON.stringify(item.bullet) && "bg-accent")}
							onClick={() => {
								focus.ran()
								target.apply(defaults => setBullet(item.bullet, defaults, item.font))
							}}
						>
							{item.bullet.kind === "char" ? (
								<span
									aria-hidden="true"
									className="w-4 text-center"
								>
									{item.bullet.char}
								</span>
							) : null}
							{item.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}

function LineSpacingMenu({ target }: { target: TextTarget }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const shown = target.paragraph.lnSpc
	const value = shown !== undefined && "pct" in shown ? String(shown.pct / 100_000) : ""

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewDocxLineSpacing")}
				icon={<ListChevronsUpDownIcon />}
				disabled={!target.enabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={next => {
						focus.ran()
						target.apply(defaults => setParaProps({ lnSpc: { pct: Math.round(Number(next) * 100_000) } }, defaults))
					}}
				>
					{LINE_SPACINGS.map(spacing => (
						<DropdownMenuRadioItem
							key={spacing}
							value={String(spacing)}
						>
							{i18n.format(spacing, "number")}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

const ALIGNS: readonly { readonly value: NonNullable<ParaProps["algn"]>; readonly label: PreviewKey; readonly icon: ReactNode }[] = [
	{ value: "l", label: "previewDocxAlignStart", icon: <AlignLeftIcon /> },
	{ value: "ctr", label: "previewDocxAlignCenter", icon: <AlignCenterIcon /> },
	{ value: "r", label: "previewDocxAlignEnd", icon: <AlignRightIcon /> },
	{ value: "just", label: "previewDocxAlignJustify", icon: <AlignJustifyIcon /> },
	{ value: "dist", label: "previewPptxTextAlignDistributed", icon: <AlignJustifyIcon /> }
]

// A menu of one body property (direction, anchoring, columns).
function BodyMenu<V extends string | number>({
	target,
	label,
	icon,
	value,
	items,
	onPick
}: {
	target: TextTarget
	label: string
	icon: ReactNode
	value: V | undefined
	items: readonly { readonly value: V; readonly label: string }[]
	onPick: (value: V) => void
}) {
	const focus = useCommandMenuFocus()

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={label}
				icon={icon}
				disabled={!target.enabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuRadioGroup
					value={value === undefined ? "" : String(value)}
					onValueChange={next => {
						focus.ran()

						const item = items.find(entry => String(entry.value) === next)

						if (item !== undefined) onPick(item.value)
					}}
				>
					{items.map(item => (
						<DropdownMenuRadioItem
							key={String(item.value)}
							value={String(item.value)}
						>
							{item.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function LinkDialog({ target, editor, onClose }: { target: TextTarget; editor: TextRibbonEditor; onClose: () => void }) {
	const { t } = useTranslation("preview")
	const current = target.run.hlinkClick
	const [kind, setKind] = useState<"url" | "slide">(current?.kind === "slide" ? "slide" : "url")
	const [url, setUrl] = useState(current?.kind === "url" ? current.href : "")
	const [slide, setSlide] = useState(current?.kind === "slide" ? String(current.slide) : String(editor.info.slides[0]?.ref ?? ""))
	const urlId = useId()
	const action = linkOfChoice(kind, url, slide, editor.info)
	const invalid = kind === "url" && url.trim() !== "" && action === null

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxTextLink")}
			description={t("previewPptxTextLinkDescription")}
			submitLabel={t("previewPptxTextLinkApply")}
			cancelLabel={t("previewPptxTextLinkCancel")}
			canSubmit={action !== null}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (action !== null) target.apply(defaults => setHyperlink(action, defaults))

				onClose()
			}}
		>
			<DocxChoiceField
				label={t("previewPptxTextLinkKind")}
				value={kind}
				items={[
					{ value: "url", label: t("previewPptxTextLinkWeb") },
					{ value: "slide", label: t("previewPptxTextLinkSlide") }
				]}
				onChange={setKind}
			/>
			{kind === "url" ? (
				<Field data-invalid={invalid || undefined}>
					<FieldLabel htmlFor={urlId}>{t("previewPptxTextLinkAddress")}</FieldLabel>
					<Input
						id={urlId}
						type="url"
						inputMode="url"
						value={url}
						maxLength={2048}
						aria-invalid={invalid || undefined}
						onChange={event => {
							setUrl(event.target.value)
						}}
					/>
					{invalid ? <FieldError>{t("previewPptxTextLinkAddressInvalid")}</FieldError> : null}
				</Field>
			) : (
				<DocxChoiceField
					label={t("previewPptxTextLinkSlide")}
					value={slide}
					items={editor.info.slides.map((entry, index) => ({
						value: String(entry.ref),
						label: t("previewPptxActionSlideNumber", { number: index + 1 })
					}))}
					onChange={setSlide}
				/>
			)}
			{current === undefined ? null : (
				<button
					type="button"
					className="self-start text-sm text-muted-foreground underline"
					onClick={() => {
						target.apply(defaults => setHyperlink(undefined, defaults))
						onClose()
					}}
				>
					{t("previewPptxTextLinkRemove")}
				</button>
			)}
		</FormDialog>
	)
}

function ParagraphControls({ target, editor }: { target: TextTarget; editor: TextRibbonEditor }) {
	const { t } = useTranslation("preview")
	const [linking, setLinking] = useState(false)
	const paragraph = target.paragraph
	const bodyPr = target.bodyPr
	const disabled = !target.enabled
	const para = (patch: ParaPatch) => (defaults: TextDefaults) => setParaProps(patch, defaults)

	return (
		<>
			<ListMenu
				target={target}
				kind="bullets"
			/>
			<ListMenu
				target={target}
				kind="numbering"
			/>
			<RibbonButton
				label={t("previewPptxTextLevelDecrease")}
				icon={<IndentDecreaseIcon />}
				disabled={disabled}
				onClick={() => {
					target.apply(defaults => changeLevel(-1, defaults))
				}}
			/>
			<RibbonButton
				label={t("previewPptxTextLevelIncrease")}
				icon={<IndentIncreaseIcon />}
				disabled={disabled}
				onClick={() => {
					target.apply(defaults => changeLevel(1, defaults))
				}}
			/>
			<LineSpacingMenu target={target} />
			{ALIGNS.map(item => (
				<RibbonButton
					key={item.value}
					label={t(item.label)}
					icon={item.icon}
					pressed={paragraph.algn === item.value}
					disabled={disabled}
					onClick={() => {
						target.apply(para({ algn: item.value }))
					}}
				/>
			))}
			<RibbonButton
				label={t("previewPptxTextRightToLeft")}
				icon={<PilcrowLeftIcon />}
				pressed={paragraph.rtl === true}
				disabled={disabled}
				onClick={() => {
					target.apply(para({ rtl: paragraph.rtl === true ? null : true }))
				}}
			/>
			<BodyMenu
				target={target}
				label={t("previewPptxTextDirection")}
				icon={<TextCursorInputIcon />}
				value={bodyPr.vertical}
				items={DIRECTIONS.map(item => ({ value: item.value, label: t(item.label) }))}
				onPick={vertical => {
					target.setBodyPr({ vertical })
				}}
			/>
			<BodyMenu
				target={target}
				label={t("previewPptxTextAnchor")}
				icon={<AlignVerticalSpaceAroundIcon />}
				value={bodyPr.anchor}
				items={ANCHORS.map(item => ({ value: item.value, label: t(item.label) }))}
				onPick={anchor => {
					target.setBodyPr({ anchor })
				}}
			/>
			<BodyMenu
				target={target}
				label={t("previewPptxTextColumns")}
				icon={<Columns2Icon />}
				value={bodyPr.columns}
				items={[1, 2, 3].map(count => ({ value: count, label: t("previewPptxTextColumnsCount", { count }) }))}
				onPick={columns => {
					target.setBodyPr({ columns })
				}}
			/>
			<RibbonButton
				label={t("previewPptxTextLink")}
				icon={<LinkIcon />}
				pressed={target.run.hlinkClick !== undefined}
				disabled={disabled}
				onClick={() => {
					setLinking(true)
				}}
			/>
			{linking ? (
				<LinkDialog
					target={target}
					editor={editor}
					onClose={() => {
						setLinking(false)
					}}
				/>
			) : null}
		</>
	)
}

// The link dialog the open body's link key (Mod+K by default) asks for: mounted by the editor next to the text editor,
// so the key works whichever ribbon tab shows.
export function TextLinkHost({ editor, editable }: { editor: TextRibbonEditor; editable: boolean }) {
	const [linking, setLinking] = useState(false)
	const target = useTextTarget(editor, editable)

	useEffect(
		() =>
			editor.text.onLinkRequest(() => {
				setLinking(true)
			}),
		[editor.text]
	)

	return linking && target.enabled ? (
		<LinkDialog
			target={target}
			editor={editor}
			onClose={() => {
				setLinking(false)
			}}
		/>
	) : null
}

export function FontGroup({ editor, editable }: { editor: TextRibbonEditor; editable: boolean }) {
	return <FontControls target={useTextTarget(editor, editable)} />
}

export function ParagraphGroup({ editor, editable }: { editor: TextRibbonEditor; editable: boolean }) {
	return (
		<ParagraphControls
			target={useTextTarget(editor, editable)}
			editor={editor}
		/>
	)
}
