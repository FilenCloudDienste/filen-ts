import { useEffect, useId, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { PlayIcon, Trash2Icon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { useElementSize } from "@/lib/useElementSize"
import type { EffectRow } from "@filen/office/core/presentation"
import { paintSlide, SlideShow, type ShowController } from "@filen/office/react/presentation"
import { Button } from "@/components/ui/button"
import {
	animationPane,
	ClassIcon,
	classLabel,
	CLASS_ORDER,
	moveEffect,
	presetLabel,
	previewFrom,
	removeEffects,
	shapeName,
	START_KEYS,
	useAnimationPane,
	useSlideAnimations,
	type AnimationPreviewRequest
} from "@/features/presentation/components/ribbon/animations"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { customPathLabel } from "@/features/presentation/components/ribbon/motionPaths"
import { usePresentationShowBindings } from "@/features/presentation/lib/keymap/show"

// The Animation Pane beside the slide: the slide's effects in play order (the click sequence, then each trigger's),
// each with its click number, its effect and object, and a bar on the slide's timeline; choosing effects here makes
// them what the Animations tab acts on. Effects reorder by drag or Alt+Up/Down within their sequence, Delete removes,
// Play From and Play All preview in the canvas. And the preview itself (AnimationPreview): the slide played by the
// show's player inside the canvas, clicked through by itself, gone when it ends, on Escape or on a click.

// A preview clicks on this long after a click's effects end.
const SETTLE_MS = 250
// The timeline shows at least this much.
const MIN_TIMELINE_MS = 1000

function timelineOf(rows: readonly EffectRow[]): number {
	let end = MIN_TIMELINE_MS

	for (const row of rows) end = Math.max(end, row.beginMs + row.durationMs * (typeof row.repeat === "number" ? row.repeat : 1))

	return end
}

const DRAG_TYPE = "application/x-filen-effect"

interface RowProps {
	readonly row: EffectRow
	// Its place in its list (px), and the list's length.
	readonly top: number
	readonly count: number
	// What the row shows, and its accessible name.
	readonly text: string
	readonly label: string
	readonly selected: boolean
	readonly timeline: number
	readonly focusable: boolean
	readonly draggable: boolean
}

// One effect of the list: only data (the list handles pointer, keys and drops for every row), so a row whose effect did
// not change is not drawn again when another moves.
function EffectItem({ row, top, count, text, label, selected, timeline, focusable, draggable }: RowProps) {
	const times = typeof row.repeat === "number" ? row.repeat : 1
	const left = Math.min(100, (row.beginMs / timeline) * 100)
	const width = Math.max(1.5, Math.min(100 - left, ((row.durationMs * times) / timeline) * 100))

	return (
		<li
			role="option"
			aria-selected={selected}
			aria-label={label}
			aria-posinset={row.index + 1}
			aria-setsize={count}
			tabIndex={focusable ? 0 : -1}
			draggable={draggable}
			data-effect={row.id}
			style={{ top }}
			className={cn(
				"absolute inset-x-0 grid h-[34px] cursor-default grid-cols-[1.5rem_1rem_minmax(0,1fr)] content-center items-center gap-x-1.5 gap-y-0.5 rounded-sm px-1.5 text-xs outline-none select-none",
				"hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/30 data-[drop]:shadow-[inset_0_2px_0_var(--color-primary)]",
				selected && "bg-accent text-accent-foreground hover:bg-accent"
			)}
		>
			<span className="text-right text-muted-foreground tabular-nums">{row.start === "click" && row.step > 0 ? row.step : ""}</span>
			<ClassIcon presetClass={row.presetClass} />
			<span className="truncate">{text}</span>
			<span
				aria-hidden
				className="relative col-start-3 h-1.5 rounded-full bg-muted"
			>
				<span
					className={cn(
						"absolute inset-y-0 rounded-full",
						row.presetClass === "entr" && "bg-emerald-600 dark:bg-emerald-400",
						row.presetClass === "emph" && "bg-amber-600 dark:bg-amber-400",
						row.presetClass === "exit" && "bg-red-600 dark:bg-red-400",
						(row.presetClass === "path" || row.presetClass === undefined) && "bg-sky-600 dark:bg-sky-400"
					)}
					style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
				/>
			</span>
		</li>
	)
}

// The rows of one list drawn: those in the window [from, to), and the list's focus row wherever it is, so Tab always
// finds the list (its roving tab stop is a drawn row).
function windowed(members: readonly EffectRow[], from: number, to: number, focus: number | undefined): { row: EffectRow; at: number }[] {
	const out: { row: EffectRow; at: number }[] = []
	const at = focus === undefined ? -1 : members.findIndex(row => row.id === focus)
	const focused = members[at]
	const end = Math.max(from, to)

	if (focused !== undefined && at < from) out.push({ row: focused, at })

	for (let k = from; k < end; k++) {
		const row = members[k]

		if (row !== undefined) out.push({ row, at: k })
	}

	if (focused !== undefined && at >= end) out.push({ row: focused, at })

	return out
}

// The list is drawn as a window over its rows (fixed heights, px): a pane over hundreds of effects draws what is in
// view, so an edit re-renders a few dozen rows, not all of them.
const ROW_PX = 36
const HEADING_PX = 24
const SEQUENCE_GAP_PX = 8
const PAD_PX = 4
const OVERSCAN_PX = 8 * ROW_PX

interface ListLayout {
	// Per sequence: its rows and where its first row starts.
	readonly sequences: readonly {
		readonly sequence: number
		readonly trigger?: number
		readonly rows: readonly EffectRow[]
		readonly top: number
	}[]
	readonly tops: ReadonlyMap<number, number>
	readonly height: number
}

function listLayout(rows: readonly EffectRow[]): ListLayout {
	const sequences: { sequence: number; trigger?: number; rows: EffectRow[]; top: number }[] = []
	const tops = new Map<number, number>()
	let y = PAD_PX

	for (const row of rows) {
		let last = sequences[sequences.length - 1]

		if (last?.sequence !== row.sequence) {
			if (last !== undefined) y += SEQUENCE_GAP_PX
			if (row.trigger !== undefined) y += HEADING_PX

			last = { sequence: row.sequence, ...(row.trigger === undefined ? {} : { trigger: row.trigger }), rows: [], top: y }
			sequences.push(last)
		}

		last.rows.push(row)
		tops.set(row.id, y)
		y += ROW_PX
	}

	return { sequences, tops, height: y + PAD_PX }
}

function rowElement(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>("[data-effect]") : null
}

export function AnimationPane({
	editor,
	editable,
	phone
}: {
	editor: PresentationRibbonEditor | undefined
	editable: boolean
	phone: boolean
}) {
	const { t } = useTranslation("preview")
	const state = useSlideAnimations(editor)
	const headingId = useId()
	const keysId = useId()
	const [list, setList] = useState<HTMLDivElement | null>(null)
	const listRef = useRef<HTMLDivElement | null>(null)
	const viewport = useElementSize(list)
	const [scroll, setScroll] = useState(0)
	const frame = useRef(0)
	const anchor = useRef<number | undefined>(undefined)
	const dropRef = useRef<HTMLElement | null>(null)
	const [announce, setAnnounce] = useState("")
	const [focusId, setFocusId] = useState<number | undefined>(undefined)
	const layout = listLayout(state.rows)

	// The effect to focus, scrolled into the window first when it is outside it (only the rows in view are drawn).
	useEffect(() => {
		const scroller = listRef.current

		if (focusId === undefined || scroller === null) return

		const element = scroller.querySelector<HTMLElement>(`[data-effect="${String(focusId)}"]`)

		if (element !== null) {
			element.focus({ preventScroll: false })

			return
		}

		const top = layout.tops.get(focusId)

		if (top !== undefined) scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2)
	}, [focusId, list, layout, scroll])

	useEffect(
		() => () => {
			cancelAnimationFrame(frame.current)
		},
		[]
	)

	if (editor === undefined || !state.pane.open) return null

	const rows = state.rows
	const byId = new Map(rows.map(row => [row.id, row]))
	const timeline = timelineOf(rows)
	const chosen = new Set(state.pane.selected)
	const first = state.pane.selected[0] ?? rows[0]?.id
	// Names once per render (each row would look its shape up otherwise).
	const names = new Map<number, string>()
	const nameOf = (id: number | undefined): string => {
		if (id === undefined) return ""

		let name = names.get(id)

		if (name === undefined) {
			name = shapeName(t, editor, id)
			names.set(id, name)
		}

		return name
	}
	const starts = { click: t(START_KEYS.click), with: t(START_KEYS.with), after: t(START_KEYS.after) }
	const presets = new Map<string, string>()
	// An effect's name with its class (an entrance and an exit of one name are told apart without the icon's colour).
	const presetOf = (row: EffectRow): string => {
		const kind = CLASS_ORDER.find(each => each === row.presetClass)
		const custom = customPathLabel(t, row.presetClass, row.presetID)
		const key = `${kind ?? ""}\u0000${String(row.preset?.id ?? "")}\u0000${row.preset?.presetClass ?? ""}\u0000${custom ?? ""}`
		let name = presets.get(key)

		if (name === undefined) {
			const effect = custom ?? presetLabel(t, row.preset)

			name = kind === undefined ? effect : t("previewPptxAnimEffectOfClass", { kind: classLabel(t, kind), effect })
			presets.set(key, name)
		}

		return name
	}
	const rowOf = (target: EventTarget | null): EffectRow | undefined => {
		const id = Number(rowElement(target)?.dataset["effect"])

		return Number.isFinite(id) ? byId.get(id) : undefined
	}
	const pick = (row: EffectRow, event: { readonly shiftKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean }): void => {
		if (event.shiftKey && anchor.current !== undefined) {
			const from = rows.findIndex(other => other.id === anchor.current)
			const to = rows.indexOf(row)
			const [a, b] = from <= to ? [from, to] : [to, from]

			animationPane.select(rows.slice(Math.max(0, a), b + 1).map(other => other.id))

			return
		}

		anchor.current = row.id

		if (event.metaKey || event.ctrlKey) {
			animationPane.select(chosen.has(row.id) ? state.pane.selected.filter(id => id !== row.id) : [...state.pane.selected, row.id])

			return
		}

		animationPane.select([row.id])

		// The effect's object is selected on the slide too, as PowerPoint does.
		if (row.shape !== undefined) editor.selection.set([row.shape])
	}
	const move = (row: EffectRow, to: number): void => {
		moveEffect(editor, state, row, to)
		setAnnounce(t("previewPptxAnimMoved", { n: to + 1 }))
		setFocusId(row.id)
	}
	const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
		const row = rowOf(event.target)

		if (row === undefined) return

		const index = rows.indexOf(row)

		if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey) {
			event.preventDefault()

			if (editable) move(row, row.index + (event.key === "ArrowUp" ? -1 : 1))

			return
		}

		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault()

			const next = rows[index + (event.key === "ArrowUp" ? -1 : 1)]

			if (next !== undefined) {
				pick(next, event)
				setFocusId(next.id)
			}

			return
		}

		if (event.key === " " || event.key === "Enter") {
			event.preventDefault()
			pick(row, event)

			return
		}

		if ((event.key === "Delete" || event.key === "Backspace") && editable) {
			event.preventDefault()
			removeEffects(editor, state, chosen.has(row.id) ? rows.filter(other => chosen.has(other.id)) : [row])
		}
	}
	const clearDrop = (): void => {
		dropRef.current?.removeAttribute("data-drop")
		dropRef.current = null
	}
	const playFrom = rows.find(row => chosen.has(row.id))

	return (
		<section
			data-preview-surface
			data-office-pane
			data-animation-pane=""
			aria-labelledby={headingId}
			className={cn(
				"flex min-h-0 shrink-0 flex-col bg-background",
				phone ? "max-h-[40dvh] w-full border-b border-border" : "w-64 border-l border-border lg:w-72"
			)}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border py-1 pr-1 pl-3">
				<h2
					id={headingId}
					className="truncate text-sm font-medium"
				>
					{t("previewPptxAnimPaneTitle")}
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("previewPptxAnimPaneClose")}
					title={t("previewPptxAnimPaneClose")}
					onClick={() => {
						animationPane.setOpen(false)
					}}
				>
					<XIcon />
				</Button>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-1">
				<Button
					variant="ghost"
					size="sm"
					disabled={rows.length === 0}
					onClick={() => {
						if (state.pane.preview !== undefined) animationPane.stop()
						else previewFrom(state, playFrom === undefined ? 0 : Math.max(1, playFrom.step))
					}}
				>
					<PlayIcon data-icon="inline-start" />
					{t(
						state.pane.preview !== undefined
							? "previewPptxAnimStopPreview"
							: playFrom === undefined
								? "previewPptxAnimPlayAll"
								: "previewPptxAnimPlayFrom"
					)}
				</Button>
				{editable ? (
					<Button
						variant="ghost"
						size="sm"
						disabled={chosen.size === 0}
						onClick={() => {
							removeEffects(
								editor,
								state,
								rows.filter(row => chosen.has(row.id))
							)
						}}
					>
						<Trash2Icon data-icon="inline-start" />
						{t("previewPptxAnimRemove")}
					</Button>
				) : null}
			</div>
			<p
				id={keysId}
				className="sr-only"
			>
				{t("previewPptxAnimReorderHint")}
			</p>
			<p
				className="sr-only"
				aria-live="polite"
			>
				{announce}
			</p>
			{state.unsupported ? (
				<p className="p-3 text-sm text-muted-foreground">{t("previewPptxAnimUnsupported")}</p>
			) : state.pane.slide === state.slide && state.pane.effects === undefined && !state.pane.failed ? (
				<p
					role="status"
					className="p-3 text-sm text-muted-foreground"
				>
					{t("previewPptxAnimPaneLoading")}
				</p>
			) : rows.length === 0 ? (
				<p className="p-3 text-sm text-muted-foreground">{t("previewPptxAnimPaneEmpty")}</p>
			) : (
				// The rows' pointer, keys and drops are handled here, once for the list. Layout and paint contained, not
				// size: in the phone pane (a maximum height only) the list takes its rows' height up to the pane's.
				<div
					ref={element => {
						listRef.current = element
						setList(element)
					}}
					className="min-h-0 flex-1 overflow-y-auto px-1 [contain:content]"
					onScroll={event => {
						const top = event.currentTarget.scrollTop

						cancelAnimationFrame(frame.current)
						frame.current = requestAnimationFrame(() => {
							setScroll(top)
						})
					}}
					onClick={(event: MouseEvent<HTMLDivElement>) => {
						const row = rowOf(event.target)

						if (row !== undefined) pick(row, event)
					}}
					onKeyDown={onKey}
					onDragStart={(event: DragEvent<HTMLDivElement>) => {
						const row = rowOf(event.target)

						if (row === undefined) return

						event.dataTransfer.effectAllowed = "move"
						event.dataTransfer.setData(DRAG_TYPE, String(row.id))
					}}
					onDragOver={(event: DragEvent<HTMLDivElement>) => {
						const element = rowElement(event.target)

						if (element === null || !event.dataTransfer.types.includes(DRAG_TYPE)) return

						event.preventDefault()
						event.dataTransfer.dropEffect = "move"

						if (dropRef.current !== element) {
							clearDrop()
							element.setAttribute("data-drop", "")
							dropRef.current = element
						}
					}}
					onDragEnd={clearDrop}
					onDrop={(event: DragEvent<HTMLDivElement>) => {
						clearDrop()

						const target = rowOf(event.target)
						const moving = byId.get(Number(event.dataTransfer.getData(DRAG_TYPE)))

						event.preventDefault()

						// Dropped on a row of its sequence: the moved effect takes that row's place.
						if (target !== undefined && moving?.sequence === target.sequence && editable) move(moving, target.index)
					}}
				>
					<div
						className="relative"
						style={{ height: layout.height }}
					>
						{layout.sequences.map(({ sequence, trigger, rows: members, top }) => {
							const heading =
								trigger === undefined
									? t("previewPptxAnimTriggerSequence")
									: t("previewPptxAnimTriggerHeading", {
											name:
												members[0]?.bookmark === undefined
													? nameOf(trigger)
													: t("previewPptxAnimTriggerBookmark", {
															bookmark: members[0].bookmark,
															name: nameOf(trigger)
														})
										})
							const from = Math.max(0, Math.floor((scroll - OVERSCAN_PX - top) / ROW_PX))
							const to = Math.min(
								members.length,
								Math.ceil((scroll + (viewport.height || ROW_PX * 20) + OVERSCAN_PX - top) / ROW_PX)
							)

							return (
								<div
									key={sequence}
									className="absolute inset-x-0"
									style={{ top: top - (trigger === undefined ? 0 : HEADING_PX) }}
								>
									{trigger === undefined ? null : (
										<h3 className="flex h-6 items-center px-1.5 text-xs font-medium text-muted-foreground">
											{heading}
										</h3>
									)}
									<ul
										role="listbox"
										aria-label={heading}
										aria-multiselectable
										aria-describedby={keysId}
										className="relative"
										style={{ height: members.length * ROW_PX }}
									>
										{windowed(members, from, to, first).map(({ row, at }) => {
											const effect = presetOf(row)
											const target =
												row.paragraph === undefined
													? nameOf(row.shape)
													: `${nameOf(row.shape)}, ${t("previewPptxAnimParagraph", { n: row.paragraph + 1 })}`

											return (
												<EffectItem
													key={row.id}
													row={row}
													top={at * ROW_PX}
													count={members.length}
													text={`${effect}: ${target}`}
													label={t("previewPptxAnimRow", { effect, target, start: starts[row.start] })}
													selected={chosen.has(row.id)}
													timeline={timeline}
													focusable={row.id === first}
													draggable={editable}
												/>
											)
										})}
									</ul>
								</div>
							)
						})}
					</div>
				</div>
			)}
		</section>
	)
}

// ---- the preview -------------------------------------------------------------------------------------------------

const STAGE_STYLE = { "--fo-show-z": "5" } as CSSProperties

// Clicks through the slide by itself: each main-sequence click once the one before has played (from `from`, the
// clicks before it seek straight to their ends), then the preview ends. A transition preview shows the slide before
// first and goes to this one (the runtime plays its transition as the show does), then ends or plays on. Answers the
// cleanup.
function driveStage(controller: ShowController, request: AnimationPreviewRequest): () => void {
	let disposed = false
	const timers: ReturnType<typeof setTimeout>[] = []
	const wait = (ms: number): Promise<void> =>
		new Promise(resolve => {
			timers.push(setTimeout(resolve, ms))
		})
	const transition = request.transition
	let shown = 0
	const off = controller.on("slide", event => {
		shown++

		if (transition !== undefined && shown === 1) {
			controller.goto(1)

			return
		}

		off()

		void (async () => {
			if (transition !== undefined && !transition.animations) {
				await wait(transition.durationMs + SETTLE_MS)

				if (!disposed) animationPane.stop()

				return
			}

			if (transition !== undefined) await wait(transition.durationMs)

			const from = request.from

			if (from > 1) for (let step = 1; step < from && step <= event.steps; step++) controller.next()
			else await wait((request.steps[0] ?? 0) + SETTLE_MS)

			for (let step = Math.max(1, from); step <= event.steps && !disposed; step++) {
				controller.next()
				await wait((request.steps[step] ?? 0) + SETTLE_MS)
			}

			if (!disposed) animationPane.stop()
		})()
	})

	return () => {
		disposed = true
		off()

		for (const timer of timers) clearTimeout(timer)
	}
}

function PreviewStage({ editor, request }: { editor: PresentationRibbonEditor; request: AnimationPreviewRequest }) {
	const { t } = useTranslation("preview")
	const render = editor.render
	// The show's keys in effect (Escape ends the preview; an arrow plays on), so a key moved off them does nothing here.
	const bindings = usePresentationShowBindings()
	// Where focus was, back there when the preview goes (the stage takes it while it plays).
	const [before] = useState(() => (typeof document === "undefined" ? null : document.activeElement))

	useEffect(
		() => () => {
			if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
		},
		[before]
	)

	if (render === undefined) return null

	const previous = request.transition === undefined ? undefined : (request.transition.previous ?? render)
	const slides = previous === undefined ? [render] : [previous, render]

	const attach = (controller: ShowController | null): (() => void) | undefined =>
		controller === null ? undefined : driveStage(controller, request)

	return (
		<div
			className="absolute inset-0 [transform:translateZ(0)] overflow-hidden [&_.fo-show-stage]:bg-muted!"
			style={STAGE_STYLE}
		>
			<SlideShow
				ref={attach}
				slides={slides.map(each => ({ ref: each.ref, hidden: false }))}
				customShows={[]}
				bindings={bindings}
				renders={new Map(slides.map(each => [each.ref, each]))}
				size={editor.info.size}
				painter={paintSlide}
				session={editor.session}
				options={{ loop: false, kiosk: true, useTimings: false }}
				from={{ index: 0 }}
				onEnd={() => {
					animationPane.stop()
				}}
				label={t("previewPptxAnimPreview")}
				slideLabel={() => ""}
				autoHidePointer={false}
				onPointer={event => {
					if (event.type === "pointerdown") animationPane.stop()

					return true
				}}
			/>
		</div>
	)
}

// The preview playing in the canvas of the slide in view (none otherwise).
export function AnimationPreview({ editor }: { editor: PresentationRibbonEditor }) {
	const pane = useAnimationPane()
	const request = pane.preview
	const slide = editor.render?.ref

	// Another slide in view ends it.
	useEffect(() => {
		if (request !== undefined && slide !== request.slide) animationPane.stop()
	}, [request, slide])

	if (request === undefined || slide !== request.slide) return null

	return (
		<PreviewStage
			key={request.key}
			editor={editor}
			request={request}
		/>
	)
}
