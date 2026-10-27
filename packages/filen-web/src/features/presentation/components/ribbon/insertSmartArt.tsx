import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { NetworkIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { DeckOp, ShapeNode, ShapeRef, SlideRef, SmartArtDefRef, SmartArtOp } from "@filen/office/core/presentation"
import {
	SMARTART_LAYOUTS,
	type SmartArtCategory,
	type SmartArtInfo,
	type SmartArtLayoutEntry,
	type SmartArtNodeInfo
} from "@filen/office/core/smartart"
import type { BitmapLike, OpenInfo, PresentationSessionApi } from "@filen/office/dom/presentation"
import { selectedShapes, slideShapes, useShapeSelection, type SlideShape } from "@filen/office/react/presentation"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { keepFocus } from "@/features/office/lib/officeControls"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"
import { useLatestRef } from "@/lib/useLatestRef"

// Insert ▸ SmartArt: a gallery of our own layouts (core/smartart's registry) by category, each previewed by the worker
// as it scrolls into view; the chosen one goes on the slide in view as one insert op, centred, with the layout's
// sample outline (or three empty nodes), selected, with the text pane open. The worker writes SmartArt into
// PowerPoint packages only, so another format's deck shows the button off with the reason; the viewer has none.
// The SmartArt editing state the Design and Format tabs and the text pane share lives here too (the pane's store and
// the outline's rules), so the group files and the pane import it from one place.

const TILE_PX = 120
const TILE_RATIO = 3 / 4

export const SMARTART_CATEGORY_KEYS: Readonly<Record<SmartArtCategory | "all", PreviewKey>> = {
	all: "previewPptxSmartArtCategoryAll",
	list: "previewPptxSmartArtCategoryList",
	process: "previewPptxSmartArtCategoryProcess",
	cycle: "previewPptxSmartArtCategoryCycle",
	hierarchy: "previewPptxSmartArtCategoryHierarchy",
	relationship: "previewPptxSmartArtCategoryRelationship",
	matrix: "previewPptxSmartArtCategoryMatrix",
	pyramid: "previewPptxSmartArtCategoryPyramid",
	picture: "previewPptxSmartArtCategoryPicture"
}

const CATEGORY_ORDER: readonly SmartArtCategory[] = [
	"list",
	"process",
	"cycle",
	"hierarchy",
	"relationship",
	"matrix",
	"pyramid",
	"picture"
]

// Whether the deck's format can hold a SmartArt graphic the editor makes (the worker refuses it elsewhere).
export function canInsertSmartArt(info: Pick<OpenInfo, "format">): boolean {
	return info.format === "pptx"
}

// The texts an insert op starts the diagram with: the layout's sample outline (a leading tab per level below the
// first), or three empty top-level nodes.
export function insertTexts(entry: Pick<SmartArtLayoutEntry, "sample">): string[] {
	if (entry.sample.length === 0) return ["", "", ""]

	return entry.sample.map(node => "\t".repeat(Math.max(0, node.level - 1)) + node.text)
}

// The insert op: the frame centred on a slide of `size` (two thirds of its width, four fifths of its height, as
// PowerPoint's default graphic), id 0 so the worker allocates one.
export function insertSmartArtOp(
	slide: SlideRef,
	size: { readonly cx: number; readonly cy: number },
	entry: SmartArtLayoutEntry,
	name: string
): SmartArtOp {
	const cx = Math.round((size.cx * 2) / 3)
	const cy = Math.round((size.cy * 4) / 5)
	const shape: ShapeNode = {
		id: 0,
		name,
		hidden: false,
		kind: "frame",
		xfrm: { x: Math.round((size.cx - cx) / 2), y: Math.round((size.cy - cy) / 2), cx, cy, rot: 0, flipH: false, flipV: false }
	}

	return {
		family: "smartart",
		kind: "insert",
		slide,
		shape,
		layout: { uniqueId: entry.uniqueId, source: "gallery" },
		texts: insertTexts(entry)
	}
}

// ---- the SmartArt pane's store (shared with the Design and Format tabs and the text pane) ------------------------

export interface SmartArtPaneState {
	readonly open: boolean
	// The diagram `info` is of, and the render revision it was read at.
	readonly target: ShapeRef | undefined
	readonly revision: number
	readonly status: "idle" | "loading" | "ready" | "failed"
	readonly info: SmartArtInfo | undefined
	// The node chosen in the pane (a dgm:pt modelId), for the Design tab.
	readonly node: string | undefined
	// A field to focus once the outline lists it, with the caret there.
	readonly focus: { readonly node: string; readonly caret: number | "end" } | undefined
}

export interface SmartArtPaneStore {
	readonly getSnapshot: () => SmartArtPaneState
	readonly subscribe: (listener: () => void) => () => void
	readonly setOpen: (open: boolean) => void
	// Reads the diagram's outline for this render of its slide, once per (diagram, revision).
	readonly request: (session: Pick<PresentationSessionApi, "smartArtInfo">, target: ShapeRef, revision: number) => void
	readonly setNode: (node: string | undefined) => void
	readonly focusNode: (node: string, caret: number | "end") => void
	readonly focused: () => void
	// The focused field (`owner`, its node) registers the op that sends what it holds unsent and how it sends it;
	// leaving, it releases it (`flush`: sending what is unsent, for a field that goes away).
	readonly setDraft: (owner: string, take: () => SmartArtOp | undefined, send: (op: SmartArtOp) => void) => void
	readonly releaseDraft: (owner: string, flush: boolean) => void
	// The unsent text as an op (now counted as sent), for a command that sends it first.
	readonly takeDraft: () => SmartArtOp | undefined
	readonly reset: () => void
}

const INITIAL: SmartArtPaneState = {
	open: false,
	target: undefined,
	revision: -1,
	status: "idle",
	info: undefined,
	node: undefined,
	focus: undefined
}

export function sameShape(a: ShapeRef | undefined, b: ShapeRef | undefined): boolean {
	if (a === undefined || b === undefined) return false

	return a.slide === b.slide && a.id === b.id
}

export function createSmartArtPane(): SmartArtPaneStore {
	let state = INITIAL
	// The session `state` was read from (another deck's refs may repeat).
	let source: unknown
	let draft: { readonly owner: string; readonly take: () => SmartArtOp | undefined; readonly send: (op: SmartArtOp) => void } | undefined
	const listeners = new Set<() => void>()
	const commit = (next: SmartArtPaneState): void => {
		state = next

		for (const listener of listeners) listener()
	}

	return {
		getSnapshot: () => state,
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		setOpen: open => {
			if (state.open !== open) commit({ ...state, open })
		},
		request: (session, target, revision) => {
			const same = sameShape(state.target, target) && source === session

			if (same && state.revision === revision && state.status !== "idle") return

			source = session

			// Another diagram starts over; a new render of the same one keeps its outline until the answer arrives.
			commit(
				same
					? { ...state, revision, status: "loading" }
					: { ...state, target, revision, status: "loading", info: undefined, node: undefined, focus: undefined }
			)

			const current = (): boolean => source === session && sameShape(state.target, target) && state.revision === revision
			let asked: Promise<SmartArtInfo>

			try {
				asked = session.smartArtInfo(target)
			} catch {
				commit({ ...state, status: "failed" })

				return
			}

			void asked.then(
				info => {
					if (current()) commit({ ...state, status: "ready", info })
				},
				() => {
					if (current()) commit({ ...state, status: "failed" })
				}
			)
		},
		setNode: node => {
			if (state.node !== node) commit({ ...state, node })
		},
		focusNode: (node, caret) => {
			commit({ ...state, node, focus: { node, caret } })
		},
		focused: () => {
			if (state.focus !== undefined) commit({ ...state, focus: undefined })
		},
		setDraft: (owner, take, send) => {
			draft = { owner, take, send }
		},
		releaseDraft: (owner, flush) => {
			if (draft?.owner !== owner) return

			const left = draft

			draft = undefined

			const op = flush ? left.take() : undefined

			if (op !== undefined) left.send(op)
		},
		takeDraft: () => draft?.take(),
		reset: () => {
			draft = undefined
			source = undefined
			commit(INITIAL)
		}
	}
}

// The editor's one pane (one presentation editor is open at a time).
export const smartArtPane = createSmartArtPane()

export function useSmartArtPane(): SmartArtPaneState {
	return useSyncExternalStore(smartArtPane.subscribe, smartArtPane.getSnapshot, smartArtPane.getSnapshot)
}

// ---- the outline -------------------------------------------------------------------------------------------------

// The sibling before or after `index` in the depth-first outline (-1: none).
function siblingOf(nodes: readonly SmartArtNodeInfo[], index: number, step: -1 | 1): number {
	const level = nodes[index]?.level

	if (level === undefined) return -1

	for (let at = index + step; at >= 0 && at < nodes.length; at += step) {
		const other = nodes[at]?.level ?? 0

		if (other === level) return at
		if (other < level) return -1
	}

	return -1
}

export interface NodeMoves {
	readonly promote: boolean
	readonly demote: boolean
	readonly up: boolean
	readonly down: boolean
}

// What the node at `index` can do: promote below the top level, demote and move up after a sibling, move down
// before one (as the worker's outline edits allow).
export function nodeMoves(nodes: readonly SmartArtNodeInfo[], index: number): NodeMoves {
	const node = nodes[index]

	if (node === undefined) return { promote: false, demote: false, up: false, down: false }

	const previous = siblingOf(nodes, index, -1) >= 0

	return { promote: node.level > 1, demote: previous, up: previous, down: siblingOf(nodes, index, 1) >= 0 }
}

// The node the Design tab acts on: the one chosen in the pane, else the last (-1: the diagram has none).
export function activeNodeIndex(info: SmartArtInfo | undefined, node: string | undefined): number {
	if (info === undefined) return -1

	const chosen = node === undefined ? -1 : info.nodes.findIndex(each => each.id === node)

	return chosen >= 0 ? chosen : info.nodes.length - 1
}

// A new node's modelId as PowerPoint writes one ({GUID}, upper case), so the next op can name it.
export function newNodeId(): string {
	return `{${crypto.randomUUID().toUpperCase()}}`
}

// A new node beside, over or under the node at `index`; an empty diagram's first node goes under its root (only
// "after" and "below" can make one). Undefined when the position is impossible.
export function addNodeOp(
	target: ShapeRef,
	info: SmartArtInfo,
	index: number,
	position: "before" | "after" | "above" | "below",
	id: string,
	text?: string
): SmartArtOp | undefined {
	const node = info.nodes[index]
	const extra = text === undefined || text === "" ? {} : { text }

	if (node === undefined) {
		return position === "after" || position === "below"
			? { family: "smartart", kind: "addNode", target, relativeTo: info.root, position: "below", id, ...extra }
			: undefined
	}

	return { family: "smartart", kind: "addNode", target, relativeTo: node.id, position, id, ...extra }
}

// One command for `op` and the pane's unsent text before it (one undo step). True when it applied.
export async function runSmartArtOp(
	editor: Pick<PresentationRibbonEditor, "command">,
	op: SmartArtOp,
	focus?: { readonly node: string; readonly caret: number | "end" }
): Promise<boolean> {
	const draft = smartArtPane.takeDraft()
	const sent: DeckOp = draft === undefined ? op : { family: "batch", kind: "batch", ops: [draft, op] }
	const result = await editor.command(sent)

	if (result.ok && focus !== undefined) smartArtPane.focusNode(focus.node, focus.caret)

	return result.ok
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

export interface SmartArtDiagram {
	readonly target: ShapeRef | undefined
	readonly shape: SlideShape | undefined
	readonly pane: SmartArtPaneState
	// The outline of `target` (undefined while it is read, or when it cannot be).
	readonly info: SmartArtInfo | undefined
}

// The SmartArt frame selected alone on the slide in view, and its outline (read for each new render of the slide).
export function useSmartArtDiagram(editor: PresentationRibbonEditor | undefined): SmartArtDiagram {
	const selection = useShapeSelection(editor?.selection ?? EMPTY_SELECTION)
	const pane = useSmartArtPane()
	const render = editor?.render
	const shapes = selectedShapes(render, selection)
	const only = shapes.length === 1 ? shapes[0] : undefined
	const shape = only?.role === "smartart" ? only : undefined
	const slide = render?.ref
	const id = shape?.id
	const revision = render?.revision ?? -1
	const session = editor?.session

	useEffect(() => {
		if (session !== undefined && slide !== undefined && id !== undefined) smartArtPane.request(session, { slide, id }, revision)
	}, [session, slide, id, revision])

	const target = slide === undefined || id === undefined ? undefined : { slide, id }

	return { target, shape, pane, info: sameShape(pane.target, target) ? pane.info : undefined }
}

// ---- previews ----------------------------------------------------------------------------------------------------

export interface SmartArtPreviewRequest {
	readonly layout: SmartArtDefRef
	readonly style?: SmartArtDefRef
	readonly colors?: SmartArtDefRef
	readonly widthPx: number
}

function previewKey(request: SmartArtPreviewRequest): string {
	const ref = (def: SmartArtDefRef | undefined): string => (def === undefined ? "" : `${def.source}:${def.uniqueId}`)

	return [ref(request.layout), ref(request.style), ref(request.colors), String(request.widthPx)].join("\u0000")
}

// The previews a dialog or menu shows, each asked of the worker once while it is open; every bitmap is closed when it
// closes (one answered after that is closed on arrival).
export class SmartArtPreviews {
	private readonly bitmaps = new Map<string, Promise<BitmapLike | undefined>>()
	private open = true
	private readonly session: Pick<PresentationSessionApi, "smartArtPreview">

	constructor(session: Pick<PresentationSessionApi, "smartArtPreview">) {
		this.session = session
	}

	get(request: SmartArtPreviewRequest): Promise<BitmapLike | undefined> {
		const key = previewKey(request)
		const known = this.bitmaps.get(key)

		if (known !== undefined) return known

		const asked = this.session
			.smartArtPreview(request.layout, {
				widthPx: request.widthPx,
				...(request.style === undefined ? {} : { style: request.style }),
				...(request.colors === undefined ? {} : { colors: request.colors })
			})
			.then(
				bitmap => {
					if (this.open) return bitmap

					bitmap.close()

					return undefined
				},
				() => undefined
			)

		this.bitmaps.set(key, asked)

		return asked
	}

	get size(): number {
		return this.bitmaps.size
	}

	reopen(): void {
		this.open = true
	}

	close(): void {
		this.open = false

		for (const asked of this.bitmaps.values()) void asked.then(bitmap => bitmap?.close())

		this.bitmaps.clear()
	}
}

// One preview cache for the component's life.
export function useSmartArtPreviews(session: Pick<PresentationSessionApi, "smartArtPreview">): SmartArtPreviews {
	const [previews] = useState(() => new SmartArtPreviews(session))

	useEffect(() => {
		previews.reopen()

		return () => {
			previews.close()
		}
	}, [previews])

	return previews
}

function devicePixels(): number {
	const ratio: unknown = Reflect.get(globalThis, "devicePixelRatio")

	return typeof ratio === "number" && ratio > 0 ? Math.min(ratio, 2) : 1
}

// A preview drawn once it scrolls into view (asked of the worker then, not before).
export function SmartArtPreviewCanvas({
	previews,
	request,
	width,
	className
}: {
	previews: SmartArtPreviews
	request: Omit<SmartArtPreviewRequest, "widthPx">
	// CSS px.
	width: number
	className?: string
}) {
	const ref = useRef<HTMLCanvasElement | null>(null)
	const widthPx = Math.round(width * devicePixels())
	const key = previewKey({ ...request, widthPx })
	// The request as of the last render (the effect runs again when its key changes).
	const latest = useLatestRef({ ...request, widthPx })

	useEffect(() => {
		const canvas = ref.current

		if (canvas === null) return

		let live = true
		const draw = (): void => {
			void previews.get(latest.current).then(bitmap => {
				const context = live && bitmap !== undefined ? canvas.getContext("2d") : null

				if (context === null || bitmap === undefined) return

				canvas.width = bitmap.width
				canvas.height = bitmap.height
				context.drawImage(bitmap, 0, 0)
			})
		}

		if (typeof IntersectionObserver === "undefined") {
			draw()

			return () => {
				live = false
			}
		}

		const observer = new IntersectionObserver(entries => {
			if (entries.some(entry => entry.isIntersecting)) {
				observer.disconnect()
				draw()
			}
		})

		observer.observe(canvas)

		return () => {
			live = false
			observer.disconnect()
		}
	}, [previews, key, latest])

	return (
		<canvas
			ref={ref}
			aria-hidden="true"
			className={cn("block rounded-md bg-white", className)}
			style={{ width, height: Math.round(width * TILE_RATIO), objectFit: "contain" }}
		/>
	)
}

// ---- the gallery -------------------------------------------------------------------------------------------------

function SmartArtGalleryDialog({
	editor,
	slide,
	before,
	onClose
}: {
	editor: PresentationRibbonEditor
	slide: SlideRef
	// The slide's top-level shapes before the insert (the new graphic is selected once the next render has it).
	before: readonly number[]
	onClose: () => void
}) {
	const { t } = useTranslation("preview")
	const previews = useSmartArtPreviews(editor.session)
	const [category, setCategory] = useState<SmartArtCategory | "all">("all")
	const shown = SMARTART_LAYOUTS.filter(entry => category === "all" || entry.category === category)
	const [chosen, setChosen] = useState<string | undefined>(SMARTART_LAYOUTS[0]?.uniqueId)
	const entry = shown.find(each => each.uniqueId === chosen)
	const gridId = useId()
	const categories: { value: SmartArtCategory | "all"; label: string }[] = [
		{ value: "all", label: t(SMARTART_CATEGORY_KEYS.all) },
		...CATEGORY_ORDER.filter(each => SMARTART_LAYOUTS.some(layout => layout.category === each)).map(each => ({
			value: each,
			label: t(SMARTART_CATEGORY_KEYS[each])
		}))
	]
	const insert = (layout: SmartArtLayoutEntry): void => {
		onClose()
		editor.selection.selectNew(slide, before)
		void editor.command(insertSmartArtOp(slide, editor.info.size, layout, t("previewPptxSmartArtDefaultName"))).then(result => {
			if (result.ok) smartArtPane.setOpen(true)
		})
	}

	return (
		<FormDialog
			open
			pending={false}
			wide
			title={t("previewPptxSmartArtGalleryTitle")}
			description={t("previewPptxSmartArtGalleryDescription")}
			submitLabel={t("previewPptxSmartArtGalleryInsert")}
			cancelLabel={t("previewPptxSmartArtCancel")}
			canSubmit={entry !== undefined}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (entry !== undefined) insert(entry)
			}}
		>
			<DocxChoiceField
				label={t("previewPptxSmartArtGalleryCategory")}
				value={category}
				items={categories}
				onChange={next => {
					setCategory(next)

					const first = SMARTART_LAYOUTS.find(each => next === "all" || each.category === next)

					if (!SMARTART_LAYOUTS.some(each => each.uniqueId === chosen && (next === "all" || each.category === next)))
						setChosen(first?.uniqueId)
				}}
			/>
			{shown.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("previewPptxSmartArtGalleryEmpty")}</p>
			) : (
				<div
					id={gridId}
					role="group"
					aria-label={t("previewPptxSmartArtGalleryLayouts")}
					className="grid max-h-[50dvh] grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2 overflow-y-auto p-0.5"
				>
					{shown.map(layout => {
						const name = t(layout.nameKey as PreviewKey)

						return (
							<button
								key={layout.uniqueId}
								type="button"
								aria-pressed={layout.uniqueId === chosen}
								className={cn(
									"flex min-w-0 flex-col items-center gap-1 rounded-xl border border-border p-1.5 text-xs outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30",
									layout.uniqueId === chosen && "border-primary bg-accent"
								)}
								onClick={() => {
									setChosen(layout.uniqueId)
								}}
								onDoubleClick={() => {
									insert(layout)
								}}
							>
								<SmartArtPreviewCanvas
									previews={previews}
									request={{ layout: { uniqueId: layout.uniqueId, source: "gallery" } }}
									width={TILE_PX}
								/>
								<span className="w-full truncate text-center leading-4">{name}</span>
							</button>
						)
					})}
				</div>
			)}
		</FormDialog>
	)
}

function InsertSmartArtControl({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const [open, setOpen] = useState(false)
	const slide = editor.render?.ref ?? scope?.editor.currentRef
	const render = editor.render ?? (slide === undefined ? undefined : scope?.editor.document.renders.get(slide))

	if (!canInsertSmartArt(editor.info)) {
		const reason = t("previewPptxSmartArtUnavailableFormat")

		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="sm"
							disabled
							focusableWhenDisabled
							aria-label={`${t("previewPptxSmartArtInsert")}: ${reason}`}
							className="shrink-0 gap-1 px-2"
							onMouseDown={keepFocus}
						>
							<NetworkIcon />
							<span className="text-xs">{t("previewPptxSmartArtGroup")}</span>
						</Button>
					}
				/>
				<TooltipContent>{reason}</TooltipContent>
			</Tooltip>
		)
	}

	return (
		<>
			<RibbonButton
				label={t("previewPptxSmartArtInsert")}
				text={t("previewPptxSmartArtGroup")}
				icon={<NetworkIcon />}
				disabled={slide === undefined || SMARTART_LAYOUTS.length === 0}
				onClick={() => {
					setOpen(true)
				}}
			/>
			{open && slide !== undefined ? (
				<SmartArtGalleryDialog
					editor={editor}
					slide={slide}
					before={slideShapes(render).map(shape => shape.id)}
					onClose={() => {
						setOpen(false)
					}}
				/>
			) : null}
		</>
	)
}

export const insertSmartArtGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [
		{
			id: "smartart",
			label: context.t("previewPptxSmartArtGroup", { ns: "preview" }),
			icon: NetworkIcon,
			width: 92,
			priority: 2,
			single: true,
			content: <InsertSmartArtControl editor={editor} />
		}
	]
}
