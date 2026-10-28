import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { TFunction } from "i18next"
import { ArrowRightLeftIcon, CopyCheckIcon, PlayIcon, SlidersHorizontalIcon, SquareIcon, TimerIcon, Volume2Icon } from "lucide-react"
import {
	durationOf,
	presetTransition,
	TRANSITION_PRESETS,
	transitionOption,
	transitionPreset,
	type Transition,
	type TransitionGroup,
	type TransitionOptionSpec,
	type TransitionPreset
} from "@filen/office/core/anim"
import type { SlideRef } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
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
import { Switch } from "@/components/ui/switch"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { animationPane, useAnimationPane } from "@/features/presentation/components/ribbon/animations"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import type { PreviewKey } from "@/lib/i18n"

// The presentation ribbon's Transitions tab: the transition into the selected slides (every ECMA, PowerPoint 2010 and
// 2013 transition and Morph, core/anim's catalog), its effect options, duration, sound and advance, and Apply To All.
// The slide's transition is read from the worker's timegraph source of the slide in view (the file's own, or the one
// the player draws in its place). Every change is one transition op over the rail's selection.

// ---- the slide's transition --------------------------------------------------------------------------------------

export interface SlideTransitionState {
	readonly slide: SlideRef | undefined
	readonly revision: number
	// The slide's own transition (undefined: none), and the one the player draws for it.
	readonly transition: Transition | undefined
	readonly played: Transition | undefined
	readonly loaded: boolean
	readonly failed: boolean
}

function createTransitionState() {
	let state: SlideTransitionState = {
		slide: undefined,
		revision: -1,
		transition: undefined,
		played: undefined,
		loaded: false,
		failed: false
	}
	let token = 0
	const listeners = new Set<() => void>()
	const set = (next: Partial<SlideTransitionState>): void => {
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
		getSnapshot: (): SlideTransitionState => state,
		// The slide's transition at `revision` of its render, asked once per revision.
		request: (session: Pick<PresentationSessionApi, "timegraph">, slide: SlideRef, revision: number): void => {
			if (state.slide === slide && state.revision === revision) return

			const mine = ++token

			set({
				slide,
				revision,
				loaded: false,
				failed: false,
				...(state.slide === slide ? {} : { transition: undefined, played: undefined })
			})
			void session.timegraph(slide).then(
				graph => {
					const played = graph.source?.transition

					if (mine === token) set({ transition: graph.source?.authored ?? played, played, loaded: true })
				},
				() => {
					if (mine === token) set({ failed: true, loaded: true, transition: undefined, played: undefined })
				}
			)
		}
	}
}

const slideTransition = createTransitionState()

const IDLE: SlideTransitionState = {
	slide: undefined,
	revision: -1,
	transition: undefined,
	played: undefined,
	loaded: false,
	failed: false
}

function useSlideTransition(editor: PresentationRibbonEditor | undefined): SlideTransitionState {
	const state = useSyncExternalStore(slideTransition.subscribe, slideTransition.getSnapshot, slideTransition.getSnapshot)
	const render = editor?.render
	const slide = render?.ref
	const revision = render?.revision ?? -1
	const session = editor?.session

	useEffect(() => {
		if (session !== undefined && slide !== undefined) slideTransition.request(session, slide, revision)
	}, [session, slide, revision])

	return state.slide === slide && slide !== undefined ? state : IDLE
}

// ---- names -------------------------------------------------------------------------------------------------------

function capitalized(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1)
}

// A transition's name in the gallery; a kind outside the catalog (a file's own) by its element name.
export function transitionName(t: TFunction<"preview">, transition: Pick<Transition, "kind" | "namespace"> | undefined): string {
	if (transition === undefined) return t("previewPptxTransitionNone")
	if (transitionPreset(transition.kind, transition.namespace) === undefined) return transition.kind

	return t(`previewPptxTransition${capitalized(transition.kind)}` as PreviewKey)
}

const GROUP_KEYS: Readonly<Record<TransitionGroup, PreviewKey>> = {
	subtle: "previewPptxTransitionsSubtle",
	exciting: "previewPptxTransitionsExciting",
	dynamic: "previewPptxTransitionsDynamic"
}

const OPTION_KEYS: Readonly<Record<string, PreviewKey>> = {
	dir: "previewPptxTransitionOptionDir",
	orient: "previewPptxTransitionOptionOrient",
	pattern: "previewPptxTransitionOptionPattern",
	spokes: "previewPptxTransitionOptionSpokes",
	option: "previewPptxTransitionOptionMorph",
	thruBlk: "previewPptxTransitionOptionThruBlk",
	isContent: "previewPptxTransitionOptionIsContent",
	isInverted: "previewPptxTransitionOptionIsInverted",
	hasBounce: "previewPptxTransitionOptionHasBounce",
	invX: "previewPptxTransitionOptionInvX",
	invY: "previewPptxTransitionOptionInvY"
}

function valueLabel(t: TFunction<"preview">, spec: TransitionOptionSpec, value: string): string {
	if (spec.name === "spokes") return t("previewPptxTransitionSpokes", { count: Number(value) })
	if (spec.name === "option") return t(`previewPptxTransitionMorph${capitalized(value)}` as PreviewKey)
	if (spec.name === "pattern") return t(`previewPptxTransitionPattern${capitalized(value)}` as PreviewKey)
	if (value === "horz") return t("previewPptxTransitionHorz")
	if (value === "vert") return t("previewPptxTransitionVert")

	return t(`previewPptxTransitionDir${capitalized(value)}` as PreviewKey)
}

const presetKey = (entry: Pick<TransitionPreset, "kind" | "namespace">): string => `${entry.namespace}:${entry.kind}`
const GROUPS: readonly TransitionGroup[] = ["subtle", "exciting", "dynamic"]
const MAX_SECONDS = 59.99
const MAX_AFTER_SECONDS = 86_399

// ---- commands ----------------------------------------------------------------------------------------------------

// What the transition commands act on: the rail's selection (the slide in view when it holds none), and the deck.
function useTargets(): { readonly selected: readonly SlideRef[]; readonly all: readonly SlideRef[] } {
	const scope = usePresentationEditor()
	const editor = scope?.editor

	return { selected: editor?.selection ?? [], all: editor?.document.slides.map(slide => slide.ref) ?? [] }
}

function setTransition(editor: PresentationRibbonEditor, slides: readonly SlideRef[], transition: Transition | undefined): void {
	if (slides.length === 0) return

	void editor.command({ family: "transition", kind: "set", slides, transition })
}

// A transition with its own options changed: the source's SMIL names (an ODP's) no longer say it.
function withOptions(transition: Transition, options: Transition["options"]): Transition {
	const own: Record<string, string | number | boolean> = {}

	for (const [name, value] of Object.entries(transition.options)) if (!name.startsWith("smil")) own[name] = value

	return { ...transition, options: { ...own, ...options } }
}

// The transition a timing control changes: the slide's, or an instant cut when it has none.
function base(transition: Transition | undefined): Transition {
	return transition ?? { kind: "cut", namespace: "p", options: {}, advance: { onClick: true } }
}

function seconds(ms: number): string {
	return String(Math.round(ms / 10) / 100)
}

function parseSeconds(text: string, max: number): number | undefined {
	const value = Number(text.trim().replace(",", "."))

	return text.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 1000) : undefined
}

// ---- controls ----------------------------------------------------------------------------------------------------

function GalleryControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const state = useSlideTransition(editor)
	const { selected } = useTargets()
	const current = state.transition
	const value = current === undefined ? "none" : presetKey(current)
	const disabled = !editor.info.editable || !state.loaded
	const fallback = current !== undefined && state.played !== undefined && state.played.kind !== current.kind ? state.played : undefined

	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t("previewPptxTransitionsGallery")}
				text={transitionName(t, current)}
				icon={<ArrowRightLeftIcon />}
				disabled={disabled}
			/>
			<DropdownMenuContent
				data-preview-surface
				// A list long enough to scroll is reachable by keyboard as itself (WCAG 2.1.1).
				tabIndex={0}
				className="max-h-[min(32rem,70vh)] w-64 overflow-y-auto"
			>
				{state.failed ? (
					<DropdownMenuGroup>
						<DropdownMenuLabel className="font-normal text-muted-foreground">
							{t("previewPptxTransitionsUnreadable")}
						</DropdownMenuLabel>
					</DropdownMenuGroup>
				) : null}
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(next: string) => {
						if (next === value) return
						if (next === "none") {
							setTransition(editor, selected, undefined)

							return
						}

						const entry = TRANSITION_PRESETS.find(candidate => presetKey(candidate) === next)

						if (entry === undefined) return

						// A new kind keeps the slide's advance and sound.
						const fresh = presetTransition(entry)

						setTransition(editor, selected, {
							...fresh,
							advance: current?.advance ?? fresh.advance,
							...(current?.sound === undefined ? {} : { sound: current.sound })
						})
					}}
				>
					<DropdownMenuRadioItem
						closeOnClick
						value="none"
					>
						{t("previewPptxTransitionNone")}
					</DropdownMenuRadioItem>
					{GROUPS.map(group => (
						<DropdownMenuGroup key={group}>
							<DropdownMenuLabel>{t(GROUP_KEYS[group])}</DropdownMenuLabel>
							{TRANSITION_PRESETS.filter(entry => entry.group === group).map(entry => (
								<DropdownMenuRadioItem
									closeOnClick
									key={presetKey(entry)}
									value={presetKey(entry)}
								>
									{transitionName(t, entry)}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuGroup>
					))}
				</DropdownMenuRadioGroup>
				{fallback === undefined ? null : (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel className="font-normal text-muted-foreground">
								{t("previewPptxTransitionsPlaysFallback", { fallback: transitionName(t, fallback) })}
							</DropdownMenuLabel>
						</DropdownMenuGroup>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Plays the slide's transition in the canvas (the Animations tab's stage, entered from the slide before it), or stops
// what plays there.
function PreviewButton({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const state = useSlideTransition(editor)
	const pane = useAnimationPane()
	const scope = usePresentationEditor()
	const playing = pane.preview !== undefined
	const slide = editor.render?.ref
	const played = state.played

	return (
		<RibbonButton
			label={playing ? t("previewPptxAnimStopPreview") : t("previewPptxTransitionsPreview")}
			text={playing ? t("previewPptxAnimStopPreview") : t("previewPptxTransitionsPreview")}
			icon={playing ? <SquareIcon /> : <PlayIcon />}
			disabled={!playing && (slide === undefined || played === undefined)}
			onClick={() => {
				if (playing) {
					animationPane.stop()

					return
				}

				if (slide === undefined || played === undefined) return

				const document = scope?.editor.document
				const index = document?.slides.findIndex(entry => entry.ref === slide) ?? -1
				const before = index > 0 ? document?.slides[index - 1]?.ref : undefined
				const previous = before === undefined ? undefined : document?.renders.get(before)

				animationPane.playTransition({ slide, durationMs: durationOf(played), ...(previous === undefined ? {} : { previous }) })
			}}
		/>
	)
}

function OptionControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const state = useSlideTransition(editor)
	const { selected } = useTargets()
	const current = state.transition
	const specs = current === undefined ? [] : (transitionPreset(current.kind, current.namespace)?.options ?? [])
	const disabled = !editor.info.editable || current === undefined || !state.loaded

	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t("previewPptxTransitionsOptions")}
				text={t("previewPptxTransitionsOptions")}
				icon={<SlidersHorizontalIcon />}
				disabled={disabled}
			/>
			<DropdownMenuContent data-preview-surface>
				{current === undefined || specs.length === 0 ? (
					<DropdownMenuGroup>
						<DropdownMenuLabel className="font-normal text-muted-foreground">
							{t("previewPptxTransitionsNoOptions")}
						</DropdownMenuLabel>
					</DropdownMenuGroup>
				) : (
					specs.map((spec, index) => {
						const value = transitionOption(current, spec.name)

						return (
							<DropdownMenuGroup key={spec.name}>
								{index > 0 && specs[index - 1]?.kind !== spec.kind ? <DropdownMenuSeparator /> : null}
								{spec.kind === "choice" ? (
									<>
										<DropdownMenuLabel>
											{t(OPTION_KEYS[spec.name] ?? "previewPptxTransitionOptionDir")}
										</DropdownMenuLabel>
										<DropdownMenuRadioGroup
											value={typeof value === "string" ? value : spec.default}
											onValueChange={(next: string) => {
												if (next !== value)
													setTransition(editor, selected, withOptions(current, { [spec.name]: next }))
											}}
										>
											{spec.values.map(option => (
												<DropdownMenuRadioItem
													closeOnClick
													key={option}
													value={option}
												>
													{valueLabel(t, spec, option)}
												</DropdownMenuRadioItem>
											))}
										</DropdownMenuRadioGroup>
									</>
								) : (
									<DropdownMenuCheckboxItem
										checked={value === true}
										onCheckedChange={(checked: boolean) => {
											setTransition(editor, selected, withOptions(current, { [spec.name]: checked }))
										}}
									>
										{t(OPTION_KEYS[spec.name] ?? "previewPptxTransitionOptionThruBlk")}
									</DropdownMenuCheckboxItem>
								)}
							</DropdownMenuGroup>
						)
					})
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function SecondsField({
	label,
	value,
	max,
	disabled,
	onCommit
}: {
	label: string
	value: number | undefined
	max: number
	disabled: boolean
	onCommit: (ms: number) => void
}) {
	const id = useId()
	const shown = value === undefined ? "" : seconds(value)
	const [text, setText] = useState(shown)
	const [seen, setSeen] = useState(shown)
	const invalid = text !== "" && parseSeconds(text, max) === undefined

	// A new answer shows the slide's value unless it is being typed.
	if (seen !== shown) {
		setSeen(shown)
		setText(shown)
	}

	const commit = (): void => {
		const parsed = parseSeconds(text, max)

		if (parsed === undefined) {
			setText(shown)

			return
		}

		if (parsed !== value) onCommit(parsed)
	}

	return (
		<label
			htmlFor={id}
			className="flex shrink-0 items-center gap-1 text-xs"
		>
			<span>{label}</span>
			<Input
				id={id}
				inputMode="decimal"
				value={text}
				disabled={disabled}
				aria-invalid={invalid}
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
		</label>
	)
}

// PowerPoint plays a transition sound from a WAV only.
const WAV_TYPES: ReadonlySet<string> = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"])

// A RIFF/WAVE header (its first 12 bytes): the bytes decide, not the name or the declared type. The worker checks the
// sniffed container again.
async function isWav(file: File): Promise<boolean> {
	const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
	const tag = (at: number): string => String.fromCharCode(...head.subarray(at, at + 4))

	return head.length === 12 && tag(0) === "RIFF" && tag(8) === "WAVE"
}

function SoundMenu({ editor, state }: { editor: PresentationRibbonEditor; state: SlideTransitionState }) {
	const { t } = useTranslation("preview")
	const { selected } = useTargets()
	const input = useRef<HTMLInputElement>(null)
	const current = state.transition
	const sound = current?.sound
	const value = sound === undefined ? "none" : sound.kind === "stop" ? "stop" : sound.part
	const disabled = !editor.info.editable || !state.loaded

	// A WAV from this device: the worker reads it once (registerMedia) and the save embeds it, stored once.
	const insert = async (file: File): Promise<void> => {
		if (!(await isWav(file).catch(() => false))) {
			toast.error(t("previewPptxTransitionsSoundNotWav"))

			return
		}

		const registered = await editor.session.registerMedia({ kind: "file", file }).catch(() => undefined)

		if (registered === undefined || "reason" in registered) {
			toast.error(t("previewPptxTransitionsSoundFailed"))

			return
		}

		if (registered.kind !== "audio" || !WAV_TYPES.has(registered.contentType)) {
			toast.error(t("previewPptxTransitionsSoundNotWav"))

			return
		}

		void editor.command({
			family: "transition",
			kind: "set",
			slides: selected,
			transition: {
				...base(current),
				sound: { kind: "embedded", part: `inserted:${String(registered.id)}`, name: file.name, loop: false }
			},
			media: registered
		})
	}

	return (
		<>
			<input
				ref={input}
				type="file"
				accept=".wav,audio/wav,audio/x-wav"
				className="hidden"
				aria-hidden
				tabIndex={-1}
				onChange={event => {
					const file = event.target.files?.[0]

					event.target.value = ""

					if (file !== undefined && selected.length > 0) void insert(file)
				}}
			/>
			<DropdownMenu>
				<RibbonMenuTrigger
					label={t("previewPptxTransitionsSound")}
					text={t("previewPptxTransitionsSound")}
					icon={<Volume2Icon />}
					disabled={disabled}
				/>
				<DropdownMenuContent data-preview-surface>
					<DropdownMenuRadioGroup
						value={value}
						onValueChange={(next: string) => {
							if (next === value) return

							const transition = base(current)
							const rest: Transition = { ...transition }

							delete rest.sound
							setTransition(
								editor,
								selected,
								next === "none" ? rest : next === "stop" ? { ...rest, sound: { kind: "stop" } } : transition
							)
						}}
					>
						<DropdownMenuRadioItem
							closeOnClick
							value="none"
						>
							{t("previewPptxTransitionsSoundNone")}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem
							closeOnClick
							value="stop"
						>
							{t("previewPptxTransitionsSoundStop")}
						</DropdownMenuRadioItem>
						{sound?.kind === "embedded" ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuRadioItem
									closeOnClick
									value={sound.part}
								>
									{sound.name ?? sound.part.slice(sound.part.lastIndexOf("/") + 1)}
								</DropdownMenuRadioItem>
							</>
						) : null}
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => {
							input.current?.click()
						}}
					>
						{t("previewPptxTransitionsSoundOther")}
					</DropdownMenuItem>
					{sound?.kind === "embedded" ? (
						<DropdownMenuCheckboxItem
							checked={sound.loop}
							onCheckedChange={(loop: boolean) => {
								if (current !== undefined) setTransition(editor, selected, { ...current, sound: { ...sound, loop } })
							}}
						>
							{t("previewPptxTransitionsSoundLoop")}
						</DropdownMenuCheckboxItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}

function TimingControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const state = useSlideTransition(editor)
	const { selected, all } = useTargets()
	const clickId = useId()
	const current = state.transition
	const disabled = !editor.info.editable || !state.loaded
	const advance = current?.advance ?? { onClick: true }
	const after = advance.afterMs
	const setAdvance = (next: Transition["advance"]): void => {
		setTransition(editor, selected, { ...base(current), advance: next })
	}

	return (
		<>
			<SecondsField
				label={t("previewPptxTransitionsDuration")}
				value={current === undefined || current.kind === "cut" ? undefined : current.durationMs}
				max={MAX_SECONDS}
				disabled={disabled || current === undefined || current.kind === "cut"}
				onCommit={ms => {
					if (current === undefined) return

					// The spd follows the duration.
					const next: Transition = { ...current, durationMs: ms }

					delete next.speed
					setTransition(editor, selected, next)
				}}
			/>
			<SoundMenu
				editor={editor}
				state={state}
			/>
			<label
				htmlFor={clickId}
				className="flex shrink-0 items-center gap-1.5 text-xs"
			>
				<Switch
					id={clickId}
					checked={advance.onClick}
					disabled={disabled}
					onCheckedChange={(onClick: boolean) => {
						setAdvance({ ...advance, onClick })
					}}
				/>
				<span>{t("previewPptxTransitionsOnClick")}</span>
			</label>
			<Switch
				aria-label={t("previewPptxTransitionsAfter")}
				checked={after !== undefined}
				disabled={disabled}
				className="shrink-0"
				onCheckedChange={(on: boolean) => {
					setAdvance(on ? { onClick: advance.onClick, afterMs: after ?? 0 } : { onClick: advance.onClick })
				}}
			/>
			<SecondsField
				label={t("previewPptxTransitionsAfter")}
				value={after}
				max={MAX_AFTER_SECONDS}
				disabled={disabled}
				onCommit={ms => {
					setAdvance({ ...advance, afterMs: ms })
				}}
			/>
			<RibbonButton
				label={t("previewPptxTransitionsApplyAll")}
				text={t("previewPptxTransitionsApplyAll")}
				icon={<CopyCheckIcon />}
				disabled={disabled || all.length === 0}
				onClick={() => {
					setTransition(editor, all, current)
				}}
			/>
		</>
	)
}

// Widths with their gaps, as the browsers lay the labelled controls out (ribbonFit's estimates).
const GALLERY = 150
const PREVIEW = 86
const OPTIONS = 126
const DURATION = 110
const SOUND = 86
const ON_CLICK = 130
const AFTER = 112
const APPLY_ALL = 112

export const transitionsGroups: PresentationGroups = context => {
	const editor = context.editor

	if (!context.editable || editor === undefined) return []

	return [
		{
			id: "transition",
			label: context.t("previewPptxTransitionsGalleryGroup", { ns: "preview" }),
			icon: ArrowRightLeftIcon,
			width: GALLERY + PREVIEW,
			priority: 9,
			content: (
				<>
					<GalleryControls editor={editor} />
					<PreviewButton editor={editor} />
				</>
			)
		},
		{
			id: "effectOptions",
			label: context.t("previewPptxTransitionsOptionsGroup", { ns: "preview" }),
			icon: SlidersHorizontalIcon,
			width: OPTIONS,
			priority: 7,
			single: true,
			content: <OptionControls editor={editor} />
		},
		{
			id: "timing",
			label: context.t("previewPptxTransitionsTimingGroup", { ns: "preview" }),
			icon: TimerIcon,
			width: DURATION + SOUND + ON_CLICK + AFTER + APPLY_ALL,
			priority: 5,
			content: <TimingControls editor={editor} />
		}
	]
}
