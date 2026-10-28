import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ClockIcon,
	ListOrderedIcon,
	MousePointerClickIcon,
	PlayIcon,
	PlusIcon,
	RepeatIcon,
	RouteIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	SquareIcon,
	StarIcon,
	StarOffIcon,
	type LucideIcon
} from "lucide-react"
import { cn } from "@filen/shared"
import {
	addEffectsOp,
	EFFECT_PRESETS,
	effectGroup,
	effectTimingOp,
	moveEffectOp,
	removeEffectsOp,
	replaceEffectOp,
	slideEffects,
	type DeckOp,
	type EffectChoice,
	type EffectClass,
	type EffectPreset,
	type EffectRepeat,
	type EffectRow,
	type EffectStart,
	type SlideEffects,
	type SlideRef
} from "@filen/office/core/presentation"
import type { PresentationSessionApi, SlideRender } from "@filen/office/dom/presentation"
import { selectedShapes, slideShapes, useShapeSelection, type SlideShape } from "@filen/office/react/presentation"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { keepFocus } from "@/features/office/lib/officeControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Animations tab: Preview (the slide's animations played in the canvas), the effect gallery (entrance, emphasis,
// exit, motion paths) and Effect Options, Add Animation, the Animation Pane, the trigger, and the selected effect's
// timing (start, duration, delay, repeat, rewind, order). The effects a command acts on are the ones chosen in the
// pane, else those of the shapes selected on the slide. Every command is one op (core/presentation edit/commands/
// timing.ts), so it undoes in one step. The tab and the pane (components/animationPane.tsx) share one small store
// (animationPane): whether the pane is open, the slide's effects as the worker last answered (asked again for each
// new render of the slide, never polled), the effects chosen in the pane, and the preview playing.

// ---- the store ---------------------------------------------------------------------------------------------------

export interface AnimationPreviewRequest {
	readonly slide: SlideRef
	// The click to play from (1: the first; 0: everything, the slide's own start included).
	readonly from: number
	// Per main-sequence click (0: with the slide), how long it plays.
	readonly steps: readonly number[]
	readonly key: number
	// Played into the slide first: its transition from `previous` (the slide before it; the slide itself for the
	// first), ending `durationMs` after it began, or going on to the animations with `animations`.
	readonly transition?: {
		readonly previous: SlideRender | undefined
		readonly durationMs: number
		readonly animations: boolean
	}
}

// What the Transitions tab's Preview plays (playTransition).
export interface TransitionPreview {
	readonly slide: SlideRef
	// The slide shown before it (its render); undefined: the slide plays its transition from itself.
	readonly previous?: SlideRender
	// The transition's duration (ms): the preview ends this long after it began, plus a settle.
	readonly durationMs: number
	// Then its animations too (from the first click, as Preview does), with the steps previewFrom computes.
	readonly animations?: { readonly steps: readonly number[] }
}

export interface AnimationPaneState {
	readonly open: boolean
	readonly slide: SlideRef | undefined
	readonly revision: number
	// Undefined while the worker reads them.
	readonly effects: SlideEffects | undefined
	readonly failed: boolean
	// Effect ids chosen in the pane.
	readonly selected: readonly number[]
	readonly preview: AnimationPreviewRequest | undefined
}

const NO_EFFECTS: SlideEffects = { kind: "effects", rows: [] }

function sameRow(a: EffectRow, b: EffectRow): boolean {
	const keys = Object.keys(a) as (keyof EffectRow)[]

	return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

// The new answer with every row that did not change kept as the object it was: the pane draws again only the rows
// an edit changed, and an answer equal to the last one is the last one (nothing is drawn again).
export function stableEffects(previous: SlideEffects | undefined, next: SlideEffects): SlideEffects {
	if (previous?.kind !== "effects" || next.kind !== "effects") return next

	const old = new Map(previous.rows.map(row => [row.id, row]))
	let same = previous.rows.length === next.rows.length
	const rows = next.rows.map((row, index) => {
		const before = old.get(row.id)
		const kept = before !== undefined && sameRow(before, row) ? before : row

		if (kept !== previous.rows[index]) same = false

		return kept
	})

	return same ? previous : { kind: "effects", rows }
}

function createAnimationPane() {
	let state: AnimationPaneState = {
		open: false,
		slide: undefined,
		revision: -1,
		effects: undefined,
		failed: false,
		selected: [],
		preview: undefined
	}
	let token = 0
	let previews = 0
	// The render last asked about: a new revision of the same slide keeps what the pane shows until its answer.
	let asked: { readonly session: object; readonly slide: SlideRef; readonly revision: number } | undefined
	const listeners = new Set<() => void>()
	const set = (next: Partial<AnimationPaneState>): void => {
		state = { ...state, ...next }

		for (const listener of listeners) listener()
	}

	return {
		subscribe: (listener: () => void): (() => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: (): AnimationPaneState => state,
		setOpen: (open: boolean): void => {
			if (state.open !== open) set({ open })
		},
		select: (ids: readonly number[]): void => {
			set({ selected: ids })
		},
		// The slide's effects for `revision` of its render (an unanimated slide needs no answer from the worker).
		request: (session: Pick<PresentationSessionApi, "timegraph">, slide: SlideRef, revision: number, animated: boolean): void => {
			if (asked?.session === session && asked.slide === slide && asked.revision === revision) return

			const other = state.slide !== slide || asked?.session !== session

			asked = { session, slide, revision }

			const mine = ++token

			if (!animated) {
				const effects = stableEffects(state.effects, NO_EFFECTS)

				if (other || effects !== state.effects || state.failed)
					set({ slide, revision, effects, failed: false, ...(other ? { selected: [] } : {}) })

				return
			}

			if (other) set({ slide, revision, failed: false, selected: [], effects: undefined })

			void session.timegraph(slide).then(
				graph => {
					if (mine !== token) return

					const effects = stableEffects(state.effects, slideEffects(graph.source?.timing))

					if (effects !== state.effects || state.failed) set({ revision, effects, failed: false })
				},
				() => {
					if (mine === token) set({ revision, failed: true, effects: undefined })
				}
			)
		},
		play: (slide: SlideRef, from: number, steps: readonly number[]): void => {
			set({ preview: { slide, from, steps, key: ++previews } })
		},
		// The slide's transition in the canvas (then its animations), on the one preview stage.
		playTransition: (request: TransitionPreview): void => {
			set({
				preview: {
					slide: request.slide,
					from: 0,
					steps: request.animations?.steps ?? [],
					key: ++previews,
					transition: {
						previous: request.previous,
						durationMs: Math.max(0, request.durationMs),
						animations: request.animations !== undefined
					}
				}
			})
		},
		stop: (): void => {
			if (state.preview !== undefined) set({ preview: undefined })
		}
	}
}

export const animationPane = createAnimationPane()

export function useAnimationPane(): AnimationPaneState {
	return useSyncExternalStore(animationPane.subscribe, animationPane.getSnapshot, animationPane.getSnapshot)
}

const EMPTY_SELECTION: PresentationRibbonEditor["selection"] = {
	getSnapshot: () => ({ slide: undefined, ids: [] }),
	subscribe: () => () => undefined,
	show: () => undefined,
	set: () => undefined,
	toggle: () => undefined,
	clear: () => undefined,
	selectNew: () => undefined,
	reconcile: () => undefined
}

export interface SlideAnimations {
	readonly slide: SlideRef | undefined
	readonly pane: AnimationPaneState
	// The slide's effects (empty while read or when the slide cannot be authored).
	readonly rows: readonly EffectRow[]
	readonly unsupported: boolean
	// The shapes selected on the slide.
	readonly shapes: readonly SlideShape[]
	// What the commands act on: the effects chosen in the pane, else those of the selected shapes.
	readonly active: readonly EffectRow[]
}

// The slide in view's effects and what the Animations commands act on (read for each new render of the slide).
export function useSlideAnimations(editor: PresentationRibbonEditor | undefined): SlideAnimations {
	const selection = useShapeSelection(editor?.selection ?? EMPTY_SELECTION)
	const pane = useAnimationPane()
	const render = editor?.render
	const slide = render?.ref
	const revision = render?.revision ?? -1
	const animated = render?.animated ?? false
	const session = editor?.session

	useEffect(() => {
		if (session !== undefined && slide !== undefined) animationPane.request(session, slide, revision, animated)
	}, [session, slide, revision, animated])

	const current = pane.slide === slide ? pane.effects : undefined
	const rows = current?.kind === "effects" ? current.rows : []
	const shapes = selectedShapes(render, selection)
	const chosen = new Set(pane.selected)
	const picked = rows.filter(row => chosen.has(row.id))
	const ids = new Set(shapes.map(shape => shape.id))

	return {
		slide,
		pane,
		rows,
		unsupported: current?.kind === "unsupported",
		shapes,
		active: picked.length > 0 ? picked : rows.filter(row => row.shape !== undefined && ids.has(row.shape))
	}
}

// ---- names -------------------------------------------------------------------------------------------------------

export const CLASS_ORDER: readonly EffectClass[] = ["entr", "emph", "exit", "path"]

const CLASS_KEYS: Readonly<Record<EffectClass, PreviewKey>> = {
	entr: "previewPptxAnimClassEntr",
	emph: "previewPptxAnimClassEmph",
	exit: "previewPptxAnimClassExit",
	path: "previewPptxAnimClassPath"
}

export function classLabel(t: TFunction<"preview">, presetClass: EffectClass): string {
	return t(CLASS_KEYS[presetClass])
}

// The class's mark in the gallery and the pane (green entrance, gold emphasis, red exit, a path), never colour alone:
// each has its own shape.
export function ClassIcon({ presetClass, className }: { presetClass: string | undefined; className?: string }) {
	const Icon: LucideIcon =
		presetClass === "path" ? RouteIcon : presetClass === "emph" ? SparklesIcon : presetClass === "exit" ? StarOffIcon : StarIcon

	return (
		<Icon
			aria-hidden
			className={cn(
				"size-4 shrink-0",
				presetClass === "entr" && "text-emerald-600 dark:text-emerald-400",
				presetClass === "emph" && "text-amber-600 dark:text-amber-400",
				presetClass === "exit" && "text-red-600 dark:text-red-400",
				presetClass === "path" && "text-sky-600 dark:text-sky-400",
				className
			)}
		/>
	)
}

export function presetLabel(t: TFunction<"preview">, preset: EffectPreset | undefined): string {
	return preset === undefined ? t("previewPptxAnimUnknownEffect") : t(`previewPptxAnimPreset${preset.name}` as PreviewKey)
}

const DIRECTIONS: Readonly<Record<number, PreviewKey>> = {
	1: "previewPptxAnimDirFromTop",
	2: "previewPptxAnimDirFromRight",
	3: "previewPptxAnimDirFromTopRight",
	4: "previewPptxAnimDirFromBottom",
	6: "previewPptxAnimDirFromBottomRight",
	8: "previewPptxAnimDirFromLeft",
	9: "previewPptxAnimDirFromTopLeft",
	12: "previewPptxAnimDirFromBottomLeft",
	16: "previewPptxAnimDirIn",
	32: "previewPptxAnimDirOut",
	528: "previewPptxAnimDirInCenter",
	36: "previewPptxAnimDirOutCenter",
	21: "previewPptxAnimDirVerticalIn",
	26: "previewPptxAnimDirHorizontalIn",
	37: "previewPptxAnimDirVerticalOut",
	42: "previewPptxAnimDirHorizontalOut"
}

const STRIP_DIRECTIONS: Readonly<Record<number, PreviewKey>> = {
	3: "previewPptxAnimDirLeftDown",
	6: "previewPptxAnimDirLeftUp",
	9: "previewPptxAnimDirRightDown",
	12: "previewPptxAnimDirRightUp"
}

// A subtype as Effect Options names it for `preset`.
export function subtypeLabel(t: TFunction<"preview">, preset: EffectPreset, subtype: number): string {
	if (preset.id === 21 && preset.presetClass !== "emph") return t("previewPptxAnimDirSpokes", { count: subtype })
	if (preset.id === 18) return t(STRIP_DIRECTIONS[subtype] ?? "previewPptxAnimDirIn")
	if (subtype === 10)
		return t(preset.id === 3 || preset.id === 14 || preset.id === 19 ? "previewPptxAnimDirHorizontal" : "previewPptxAnimDirAcross")
	if (subtype === 5)
		return t(preset.id === 3 || preset.id === 14 || preset.id === 19 ? "previewPptxAnimDirVertical" : "previewPptxAnimDirDown")

	return t(DIRECTIONS[subtype] ?? "previewPptxAnimDirIn")
}

export const START_KEYS: Readonly<Record<EffectStart, PreviewKey>> = {
	click: "previewPptxAnimStartClick",
	with: "previewPptxAnimStartWith",
	after: "previewPptxAnimStartAfter"
}

// A shape's name for the pane and the trigger menu: its alt title or text, else its number.
export function shapeName(t: TFunction<"preview">, editor: PresentationRibbonEditor | undefined, id: number | undefined): string {
	if (id === undefined) return ""

	const shape = editor?.render === undefined ? undefined : slideShapes(editor.render).find(each => each.id === id)
	const alt = shape?.alt?.title ?? shape?.alt?.descr

	return alt !== undefined && alt.trim() !== "" ? alt.trim().slice(0, 60) : t("previewPptxAnimShape", { id })
}

// ---- commands ----------------------------------------------------------------------------------------------------

function aspectOf(editor: PresentationRibbonEditor): number {
	const { cx, cy } = editor.info.size

	return cy > 0 ? cx / cy : 16 / 9
}

function flat(ops: readonly (DeckOp | undefined)[]): DeckOp | undefined {
	const out: DeckOp[] = []

	for (const op of ops) {
		if (op === undefined) continue
		if (op.family === "batch") out.push(...op.ops)
		else out.push(op)
	}

	return out.length === 0 ? undefined : out.length === 1 ? out[0] : { family: "batch", kind: "batch", ops: out }
}

// The first of each effect group (a by-paragraph effect's paragraphs are one), last in the list first: replacing
// one never moves another's place.
function groupsOf(rows: readonly EffectRow[], active: readonly EffectRow[]): EffectRow[] {
	const seen = new Set<number>()
	const firsts: EffectRow[] = []

	for (const row of active) {
		const members = effectGroup(rows, row)
		const first = members[0] ?? row

		if (seen.has(first.id)) continue

		for (const member of members) seen.add(member.id)

		firsts.push(first)
	}

	return firsts.sort((a, b) => b.sequence - a.sequence || b.index - a.index)
}

async function paragraphsOf(editor: PresentationRibbonEditor, slide: SlideRef, id: number): Promise<number> {
	try {
		const seed = await editor.session.textSeed({ slide, id })

		return seed.body.paragraphs.filter(paragraph => paragraph.runs.length > 0).length
	} catch {
		return 0
	}
}

function hasText(editor: PresentationRibbonEditor, shape: SlideShape): boolean {
	return shape.layers.some(index => {
		return editor.render?.layers[index]?.text !== undefined
	})
}

// A gallery pick: replaces the effects acted on (each where it is), and adds it to the selected shapes with none.
export function pickEffect(editor: PresentationRibbonEditor, state: SlideAnimations, preset: EffectPreset, add: boolean): void {
	const slide = state.slide

	if (slide === undefined) return

	const choice: EffectChoice = { preset, aspect: aspectOf(editor) }
	const animated = new Set(state.active.map(row => row.shape))
	const replaced = add ? [] : groupsOf(state.rows, state.active).map(row => replaceEffectOp(slide, state.rows, row, choice))
	const fresh = state.shapes.filter(shape => add || !animated.has(shape.id)).map(shape => ({ id: shape.id }))
	const op = flat([...replaced, fresh.length === 0 ? undefined : addEffectsOp(slide, state.rows, fresh, choice)])

	if (op !== undefined) void editor.command(op)
}

export function removeEffects(editor: PresentationRibbonEditor, state: SlideAnimations, rows: readonly EffectRow[]): void {
	if (state.slide === undefined) return

	const ids = new Set<number>()

	for (const row of rows) for (const member of effectGroup(state.rows, row)) ids.add(member.id)

	const op = removeEffectsOp(state.slide, [...ids])

	if (op !== undefined) {
		animationPane.select([])
		void editor.command(op)
	}
}

export function moveEffect(editor: PresentationRibbonEditor, state: SlideAnimations, row: EffectRow, to: number): void {
	if (state.slide === undefined) return

	const count = state.rows.filter(other => other.sequence === row.sequence).length

	if (to < 0 || to >= count || to === row.index) return

	void editor.command(moveEffectOp(state.slide, row.id, to))
}

function timeEffects(editor: PresentationRibbonEditor, state: SlideAnimations, timing: Parameters<typeof effectTimingOp>[2]): void {
	if (state.slide === undefined) return

	const op = effectTimingOp(
		state.slide,
		state.active.map(row => row.id),
		timing
	)

	if (op !== undefined) void editor.command(op)
}

// Effect Options: every effect acted on made again with `change` (direction, colour, sequence, text by word/letter).
async function changeOptions(
	editor: PresentationRibbonEditor,
	state: SlideAnimations,
	change: Partial<Pick<EffectChoice, "subtype" | "color" | "byParagraph" | "iterate">> & { readonly allText?: boolean }
): Promise<void> {
	const slide = state.slide

	if (slide === undefined) return

	const ops: (DeckOp | undefined)[] = []

	for (const row of groupsOf(state.rows, state.active)) {
		const preset = row.preset

		if (preset === undefined || row.shape === undefined) continue

		const byParagraph = change.byParagraph ?? row.paragraph !== undefined
		const members = effectGroup(state.rows, row)
		const paragraphs = byParagraph ? (row.paragraph === undefined ? await paragraphsOf(editor, slide, row.shape) : members.length) : 0
		const iterate =
			change.allText === true
				? undefined
				: (change.iterate ?? (row.iterate === undefined ? undefined : { type: row.iterate, pct: 10_000 }))
		const choice: EffectChoice = {
			preset,
			aspect: aspectOf(editor),
			subtype: change.subtype !== undefined && preset.subtypes.includes(change.subtype) ? change.subtype : (row.presetSubtype ?? 0),
			byParagraph: paragraphs > 0,
			...(change.color === undefined ? {} : { color: change.color }),
			...(iterate === undefined ? {} : { iterate })
		}

		ops.push(replaceEffectOp(slide, state.rows, row, choice, paragraphs))
	}

	const op = flat(ops)

	if (op !== undefined) await editor.command(op)
}

// Plays the slide's animations in the canvas from the click `from` (0: all of them).
export function previewFrom(state: SlideAnimations, from: number): void {
	if (state.slide === undefined) return

	const steps: number[] = []

	for (const row of state.rows) {
		if (row.sequence !== 0) continue

		while (steps.length <= row.step) steps.push(0)

		const once = row.durationMs * (row.autoReverse ? 2 : 1) * (typeof row.repeat === "number" ? row.repeat : 1)

		steps[row.step] = Math.max(steps[row.step] ?? 0, row.beginMs + once)
	}

	animationPane.play(state.slide, from, steps)
}

// ---- the tab's controls ------------------------------------------------------------------------------------------

function EffectGallery({
	editor,
	state,
	add,
	label,
	icon,
	text
}: {
	editor: PresentationRibbonEditor
	state: SlideAnimations
	add: boolean
	label: string
	icon: ReactNode
	text: string
}) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const shapes = state.shapes
	const textual = shapes.some(shape => hasText(editor, shape))
	const current = state.active[0]
	const disabled = !editor.info.editable || state.unsupported || (shapes.length === 0 && state.active.length === 0)

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={label}
				text={text}
				icon={icon}
				disabled={disabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				// A list long enough to scroll is reachable by keyboard as itself (WCAG 2.1.1).
				tabIndex={0}
				className="max-h-[min(32rem,70dvh)] w-[min(40rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]"
			>
				{add || state.active.length === 0 ? null : (
					<DropdownMenuGroup>
						<DropdownMenuItem
							onClick={() => {
								focus.ran()
								removeEffects(editor, state, state.active)
							}}
						>
							<SquareIcon aria-hidden />
							{t("previewPptxAnimNone")}
						</DropdownMenuItem>
					</DropdownMenuGroup>
				)}
				{CLASS_ORDER.map(presetClass => (
					<DropdownMenuGroup key={presetClass}>
						<DropdownMenuLabel>{classLabel(t, presetClass)}</DropdownMenuLabel>
						<div className="grid grid-cols-2 gap-0.5 px-1 pb-1 sm:grid-cols-4">
							{EFFECT_PRESETS.filter(preset => preset.presetClass === presetClass).map(preset => {
								const unusable = preset.needs === "text" && !textual
								const chosen = current?.presetClass === preset.presetClass && current.presetID === preset.id

								return (
									<DropdownMenuItem
										key={`${preset.presetClass}:${String(preset.id)}`}
										disabled={unusable}
										aria-current={chosen ? "true" : undefined}
										className={cn("min-w-0 gap-1.5 text-xs", chosen && "bg-accent")}
										onMouseDown={keepFocus}
										onClick={() => {
											focus.ran()
											pickEffect(editor, state, preset, add)
										}}
									>
										<ClassIcon presetClass={preset.presetClass} />
										<span className="truncate">{presetLabel(t, preset)}</span>
									</DropdownMenuItem>
								)
							})}
						</div>
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

const ACCENTS = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"] as const

function EffectOptions({ editor, state }: { editor: PresentationRibbonEditor; state: SlideAnimations }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const row = state.active[0]
	const preset = row?.preset
	const textual = row?.shape !== undefined && state.shapes.length <= 1 && row.presetClass !== "path"
	const disabled = !editor.info.editable || preset === undefined
	const run = (change: Parameters<typeof changeOptions>[2]): void => {
		focus.ran()
		void changeOptions(editor, state, change)
	}

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxAnimEffectOptions")}
				text={t("previewPptxAnimEffectOptions")}
				icon={<SlidersHorizontalIcon />}
				disabled={disabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="max-h-80 min-w-52"
			>
				{preset === undefined ? null : (
					<>
						{preset.subtypes.length === 0 ? null : (
							<DropdownMenuGroup>
								<DropdownMenuLabel>{t("previewPptxAnimDirection")}</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={String(row?.presetSubtype ?? 0)}
									onValueChange={value => {
										run({ subtype: Number(value) })
									}}
								>
									{preset.subtypes.map(subtype => (
										<DropdownMenuRadioItem
											key={subtype}
											value={String(subtype)}
										>
											{subtypeLabel(t, preset, subtype)}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						)}
						{preset.colored === true ? (
							<DropdownMenuGroup>
								<DropdownMenuLabel>{t("previewPptxAnimColor")}</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value=""
									onValueChange={value => {
										run({ color: { kind: "scheme", slot: value as (typeof ACCENTS)[number] } })
									}}
								>
									{ACCENTS.map((slot, index) => (
										<DropdownMenuRadioItem
											key={slot}
											value={slot}
										>
											{t("previewPptxAnimAccent", { n: index + 1 })}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						) : null}
						{textual ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									<DropdownMenuLabel>{t("previewPptxAnimSequence")}</DropdownMenuLabel>
									<DropdownMenuRadioGroup
										value={row.paragraph === undefined ? "one" : "para"}
										onValueChange={value => {
											run({ byParagraph: value === "para" })
										}}
									>
										<DropdownMenuRadioItem value="one">{t("previewPptxAnimAsOneObject")}</DropdownMenuRadioItem>
										<DropdownMenuRadioItem value="para">{t("previewPptxAnimByParagraph")}</DropdownMenuRadioItem>
									</DropdownMenuRadioGroup>
								</DropdownMenuGroup>
								<DropdownMenuGroup>
									<DropdownMenuLabel>{t("previewPptxAnimAnimateText")}</DropdownMenuLabel>
									<DropdownMenuRadioGroup
										value={row.iterate ?? "all"}
										onValueChange={value => {
											run(
												value === "all"
													? { allText: true }
													: { iterate: { type: value === "lt" ? "lt" : "wd", pct: 10_000 } }
											)
										}}
									>
										<DropdownMenuRadioItem value="all">{t("previewPptxAnimAllAtOnce")}</DropdownMenuRadioItem>
										<DropdownMenuRadioItem value="wd">{t("previewPptxAnimByWord")}</DropdownMenuRadioItem>
										<DropdownMenuRadioItem value="lt">{t("previewPptxAnimByLetter")}</DropdownMenuRadioItem>
									</DropdownMenuRadioGroup>
								</DropdownMenuGroup>
							</>
						) : null}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function TriggerMenu({ editor, state }: { editor: PresentationRibbonEditor; state: SlideAnimations }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const row = state.active[0]
	const shapes = editor.render === undefined ? [] : slideShapes(editor.render)

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxAnimTrigger")}
				text={t("previewPptxAnimTrigger")}
				icon={<MousePointerClickIcon />}
				disabled={!editor.info.editable || row === undefined}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="max-h-80 min-w-56"
			>
				<DropdownMenuRadioGroup
					value={row?.trigger === undefined ? "sequence" : String(row.trigger)}
					onValueChange={value => {
						focus.ran()
						timeEffects(editor, state, {
							trigger: value === "sequence" ? { kind: "none" } : { kind: "shapeClick", shape: Number(value) }
						})
					}}
				>
					<DropdownMenuRadioItem value="sequence">{t("previewPptxAnimTriggerSequence")}</DropdownMenuRadioItem>
					{shapes.map(shape => (
						<DropdownMenuRadioItem
							key={shape.id}
							value={String(shape.id)}
						>
							{t("previewPptxAnimTriggerShape", { name: shapeName(t, editor, shape.id) })}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

const MAX_SECONDS = 600

// Seconds as typed ("1.5", "1,5", "2 s"), or undefined outside [0, MAX_SECONDS].
export function parseSeconds(text: string): number | undefined {
	const value = Number(
		text
			.replace(",", ".")
			.replace(/\s*s\s*$/u, "")
			.trim()
	)

	return text.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS ? value : undefined
}

function seconds(ms: number): string {
	return String(Math.round(ms / 10) / 100)
}

function SecondsField({
	label,
	value,
	disabled,
	onCommit
}: {
	label: string
	value: number | undefined
	disabled: boolean
	onCommit: (ms: number) => void
}) {
	const { t } = useTranslation("preview")
	const id = useId()
	const shown = value === undefined ? "" : seconds(value)
	const [text, setText] = useState(shown)
	const [seen, setSeen] = useState(shown)
	const invalid = text !== "" && parseSeconds(text) === undefined

	// A new answer shows the effect's value unless it is being typed.
	if (seen !== shown) {
		setSeen(shown)
		setText(shown)
	}

	const commit = (): void => {
		const parsed = parseSeconds(text)

		if (parsed === undefined) {
			setText(shown)

			return
		}

		if (Math.round(parsed * 1000) !== value) onCommit(Math.round(parsed * 1000))
	}

	return (
		<label
			htmlFor={id}
			className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
		>
			<span aria-hidden>{label}</span>
			<Input
				id={id}
				aria-label={label}
				inputMode="decimal"
				value={text}
				disabled={disabled}
				aria-invalid={invalid}
				title={invalid ? t("previewPptxAnimSecondsRange", { max: MAX_SECONDS }) : undefined}
				className="h-7 w-14 px-1.5 text-xs leading-5"
				onChange={event => {
					setText(event.target.value)
				}}
				onBlur={commit}
				onKeyDown={event => {
					if (event.key === "Enter") {
						event.preventDefault()
						commit()
					} else if (event.key === "Escape") setText(shown)
				}}
			/>
			<span
				aria-hidden
				className="mr-1"
			>
				{t("previewPptxAnimSeconds")}
			</span>
		</label>
	)
}

const REPEATS: readonly { readonly value: string; readonly repeat: EffectRepeat }[] = [
	{ value: "1", repeat: 1 },
	{ value: "2", repeat: 2 },
	{ value: "3", repeat: 3 },
	{ value: "4", repeat: 4 },
	{ value: "5", repeat: 5 },
	{ value: "10", repeat: 10 },
	{ value: "next", repeat: "untilNextClick" },
	{ value: "end", repeat: "untilEndOfSlide" }
]

function repeatValue(repeat: EffectRepeat | undefined): string {
	return repeat === "untilNextClick" ? "next" : repeat === "untilEndOfSlide" ? "end" : String(repeat ?? 1)
}

function repeatLabel(t: TFunction<"preview">, repeat: EffectRepeat): string {
	if (repeat === "untilNextClick") return t("previewPptxAnimRepeatNextClick")
	if (repeat === "untilEndOfSlide") return t("previewPptxAnimRepeatEndOfSlide")

	return repeat === 1 ? t("previewPptxAnimRepeatOnce") : t("previewPptxAnimRepeatTimes", { count: repeat })
}

function TimingControls({ editor, state }: { editor: PresentationRibbonEditor; state: SlideAnimations }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const row = state.active[0]
	const disabled = !editor.info.editable || row === undefined
	const starts = (["click", "with", "after"] as const).map(start => ({ value: start, label: t(START_KEYS[start]) }))
	const count = row === undefined ? 0 : state.rows.filter(other => other.sequence === row.sequence).length

	return (
		<>
			<Select
				items={starts}
				value={row?.start ?? "click"}
				disabled={disabled}
				onOpenChange={focus.opened}
				onOpenChangeComplete={focus.settled}
				onValueChange={value => {
					if (value === "click" || value === "with" || value === "after") timeEffects(editor, state, { start: value })
				}}
			>
				<SelectTrigger
					size="sm"
					aria-label={t("previewPptxAnimStart")}
					className="w-36 shrink-0"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent data-preview-surface>
					<SelectGroup>
						{starts.map(start => (
							<SelectItem
								key={start.value}
								value={start.value}
							>
								{start.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
			<SecondsField
				label={t("previewPptxAnimDuration")}
				value={row?.durationMs}
				disabled={row === undefined || disabled || row.durationMs <= 1}
				onCommit={ms => {
					timeEffects(editor, state, { durationMs: Math.max(10, ms) })
				}}
			/>
			<SecondsField
				label={t("previewPptxAnimDelay")}
				value={row?.delayMs}
				disabled={disabled}
				onCommit={ms => {
					timeEffects(editor, state, { delayMs: ms })
				}}
			/>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewPptxAnimRepeat")}
					icon={<RepeatIcon />}
					disabled={disabled}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
					className="min-w-48"
				>
					<DropdownMenuRadioGroup
						value={repeatValue(row?.repeat)}
						onValueChange={value => {
							focus.ran()

							const item = REPEATS.find(candidate => candidate.value === value)

							if (item !== undefined) timeEffects(editor, state, { repeat: item.repeat })
						}}
					>
						{REPEATS.map(item => (
							<DropdownMenuRadioItem
								key={item.value}
								value={item.value}
							>
								{repeatLabel(t, item.repeat)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuCheckboxItem
						checked={row?.rewind === true}
						onCheckedChange={checked => {
							focus.ran()
							timeEffects(editor, state, { rewind: checked })
						}}
					>
						{t("previewPptxAnimRewind")}
					</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<RibbonButton
				label={t("previewPptxAnimEarlier")}
				icon={<ArrowUpIcon />}
				disabled={row === undefined || disabled || row.index === 0 || state.active.length !== 1}
				onClick={() => {
					if (row !== undefined) moveEffect(editor, state, row, row.index - 1)
				}}
			/>
			<RibbonButton
				label={t("previewPptxAnimLater")}
				icon={<ArrowDownIcon />}
				disabled={row === undefined || disabled || row.index >= count - 1 || state.active.length !== 1}
				onClick={() => {
					if (row !== undefined) moveEffect(editor, state, row, row.index + 1)
				}}
			/>
		</>
	)
}

function PreviewButton({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const state = useSlideAnimations(editor)
	const playing = state.pane.preview !== undefined

	return (
		<RibbonButton
			label={t(playing ? "previewPptxAnimStopPreview" : "previewPptxAnimPreview")}
			text={t(playing ? "previewPptxAnimStopPreview" : "previewPptxAnimPreview")}
			icon={playing ? <SquareIcon /> : <PlayIcon />}
			disabled={!playing && state.rows.length === 0}
			onClick={() => {
				if (playing) animationPane.stop()
				else previewFrom(state, 0)
			}}
		/>
	)
}

function AnimationControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const state = useSlideAnimations(editor)

	return (
		<>
			<EffectGallery
				editor={editor}
				state={state}
				add={false}
				label={t("previewPptxAnimEffects")}
				text={t("previewPptxAnimEffects")}
				icon={<StarIcon />}
			/>
			<EffectOptions
				editor={editor}
				state={state}
			/>
		</>
	)
}

function AdvancedControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const state = useSlideAnimations(editor)

	return (
		<>
			<EffectGallery
				editor={editor}
				state={state}
				add
				label={t("previewPptxAnimAdd")}
				text={t("previewPptxAnimAdd")}
				icon={<PlusIcon />}
			/>
			<RibbonButton
				label={t("previewPptxAnimPane")}
				text={t("previewPptxAnimPane")}
				icon={<ListOrderedIcon />}
				pressed={state.pane.open}
				onClick={() => {
					animationPane.setOpen(!state.pane.open)
				}}
			/>
			<TriggerMenu
				editor={editor}
				state={state}
			/>
		</>
	)
}

function TimingGroup({ editor }: { editor: PresentationRibbonEditor }) {
	const state = useSlideAnimations(editor)

	return (
		<TimingControls
			editor={editor}
			state={state}
		/>
	)
}

// Widths with their gaps, as the browsers lay the controls out (ribbonFit's estimates).
const PREVIEW = 92
const GALLERY = 104
const OPTIONS = 140
const ADD = 136
const PANE = 140
const TRIGGER = 98
const TIMING = 144 + 112 + 96 + 40 + 2 * 30 + 16

export const animationsGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined) return []

	const groups = [
		{
			id: "animPreview",
			label: context.t("previewPptxAnimPreviewGroup", { ns: "preview" }),
			icon: PlayIcon,
			width: PREVIEW,
			priority: 6,
			single: true,
			content: <PreviewButton editor={editor} />
		}
	]

	if (!context.editable) return groups

	return [
		...groups,
		{
			id: "animEffects",
			label: context.t("previewPptxAnimAnimationGroup", { ns: "preview" }),
			icon: StarIcon,
			width: GALLERY + OPTIONS,
			priority: 8,
			content: <AnimationControls editor={editor} />
		},
		{
			id: "animAdvanced",
			label: context.t("previewPptxAnimAdvancedGroup", { ns: "preview" }),
			icon: PlusIcon,
			width: ADD + PANE + TRIGGER,
			priority: 5,
			content: <AdvancedControls editor={editor} />
		},
		{
			id: "animTiming",
			label: context.t("previewPptxAnimTimingGroup", { ns: "preview" }),
			icon: ClockIcon,
			width: TIMING,
			priority: 4,
			content: <TimingGroup editor={editor} />
		}
	]
}
