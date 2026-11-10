import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, LayersIcon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import {
	canZOrder,
	nameOp,
	outlineEditable,
	outlineLevel,
	outlineRows,
	reorderOp,
	visibilityAllOp,
	visibilityOp,
	zOrderOp,
	type DeckOp,
	type OutlineRow,
	type OutlineShape,
	type ZOrder
} from "@filen/office/core/presentation"
import { createShapeSelection, useShapeSelection, type ObjectKeyBindings, type ShapeSelectionState } from "@filen/office/react/presentation"
import { chordText } from "@/lib/keymap/keyText"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { matchesCombo, parseCombo } from "@filen/shared/keymap"
import { usePresentationObjectBindings } from "@/features/presentation/lib/keymap/objects"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { useSelectionPane, type SelectionPaneStore } from "@/features/presentation/lib/selectionPane"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Selection Pane (Alt+F10; Home ▸ Arrange ▸ Selection Pane), docked right of the slide as PowerPoint's: every
// object of the slide, the front-most at the top, groups as rows whose members are indented under them. A row's click
// selects its object on the slide (Ctrl/Cmd adds, Shift a range of its level), double-click or F2 renames it, its eye
// hides or shows it; Show All and Hide All change every object at once, the arrows bring forward and send backward,
// and a row dragged above or below another of its level restacks it there. The keys are PowerPoint's (Microsoft's
// "Keyboard shortcuts in PowerPoint", Selection pane). The list is the worker's outline of the slide, asked for per
// render of the slide only while the pane is open.

const ROLE_KEYS: Readonly<Record<OutlineShape["role"], PreviewKey>> = {
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

// The name a row shows: the file's, else what the object is with its id (PowerPoint names every object).
function outlineName(t: TFunction<"preview">, shape: OutlineShape): string {
	if (shape.name.trim() !== "") return shape.name

	const kind =
		shape.media === undefined
			? t(ROLE_KEYS[shape.role])
			: t(shape.media === "audio" ? "previewPptxObjectAudio" : "previewPptxObjectVideo")

	return t("previewPptxSelectionUnnamed", { kind, id: shape.id })
}

const IS_MAC = isMacPlatform()

// The object actions whose keys restack the objects chosen in the pane, as they do the ones selected on the slide.
const Z_ORDER_KEYS: readonly (readonly [keyof ObjectKeyBindings, ZOrder])[] = [
	["bringToFront", "front"],
	["sendToBack", "back"],
	["bringForward", "forward"],
	["sendBackward", "backward"]
]

const DRAG_TYPE = "application/x-filen-outline"
const ROW_PX = 28
const INDENT_PX = 16
const NO_SELECTION = createShapeSelection()

interface Extra {
	// Hidden objects chosen in the pane (the slide cannot select what it does not draw), while the slide's selection is
	// still `with`.
	readonly ids: readonly number[]
	readonly with: ShapeSelectionState
}

// A command's keys as text ("Ctrl+] / Ctrl+Shift+F"; "" when it has none).
function keysText(combo: string): string {
	return parseCombo(combo)
		.map(chord => chordText(chord))
		.join(" / ")
}

// The pane's own keys (Mod: Ctrl, or Cmd on a Mac), as the list's keydown reads them.
const ADD_KEYS = "mod+space"
const VISIBILITY_KEYS = "mod+shift+s"

// The list's keyboard help, in this platform's glyphs, with the stacking keys in effect (left out when either is
// unbound).
function selectionKeysHelp(t: TFunction<"preview">, bindings: ObjectKeyBindings): string {
	const forward = keysText(bindings.bringForward)
	const backward = keysText(bindings.sendBackward)
	const add = keysText(ADD_KEYS)
	const visibility = keysText(VISIBILITY_KEYS)

	return forward === "" || backward === ""
		? t("previewPptxSelectionKeysNoOrder", { add, visibility })
		: t("previewPptxSelectionKeysOrder", { add, visibility, forward, backward })
}

function rowElement(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>("[data-outline]") : null
}

export function SelectionPane({
	editor,
	store,
	editable,
	phone,
	onLeave
}: {
	editor: PresentationRibbonEditor | undefined
	store: SelectionPaneStore
	editable: boolean
	phone: boolean
	// Escape: back to the slide.
	onLeave: () => void
}) {
	const { t } = useTranslation("preview")
	const objectBindings = usePresentationObjectBindings()
	const pane = useSelectionPane(store)
	const selectionStore = editor?.selection ?? NO_SELECTION
	const selection = useShapeSelection(selectionStore)
	const headingId = useId()
	const keysId = useId()
	const treeRef = useRef<HTMLDivElement | null>(null)
	const anchor = useRef<number | undefined>(undefined)
	const drag = useRef<{ readonly ids: readonly number[]; readonly parent: number } | undefined>(undefined)
	const dropRef = useRef<HTMLElement | null>(null)
	const [extra, setExtra] = useState<Extra | undefined>(undefined)
	const [focusId, setFocusId] = useState<number | undefined>(undefined)
	const [renaming, setRenaming] = useState<number | undefined>(undefined)
	const [announce, setAnnounce] = useState("")
	const render = editor?.render
	const slide = render?.ref
	const revision = render?.revision ?? -1
	const session = editor?.session

	useEffect(() => {
		if (pane.open && session !== undefined && slide !== undefined) store.request(session, slide, revision)
	}, [pane.open, session, slide, revision, store])

	// Alt+F10: into the list (its focus row), else the pane's first control.
	useEffect(() => {
		if (pane.focus === 0) return

		const tree = treeRef.current
		const row = tree?.querySelector<HTMLElement>('[data-outline][tabindex="0"]')

		;(row ?? tree?.closest("section")?.querySelector<HTMLElement>("button") ?? null)?.focus({ preventScroll: false })
	}, [pane.focus])

	// The row keys moved to takes focus once drawn.
	useEffect(() => {
		if (focusId === undefined || renaming !== undefined) return

		const element = treeRef.current?.querySelector<HTMLElement>(`[data-outline="${String(focusId)}"]`)

		if (
			element !== null &&
			element !== undefined &&
			element !== document.activeElement &&
			treeRef.current?.contains(document.activeElement)
		)
			element.focus({ preventScroll: false })
	}, [focusId, renaming])

	if (!pane.open || editor === undefined) return null

	const outline = pane.outline?.slide === slide ? pane.outline : undefined
	const shapes = outline?.shapes ?? []
	const rows = outlineRows(shapes, pane.collapsed)
	const byId = new Map<number, OutlineRow>()
	// Drawn on the slide: neither it nor a group it is in hidden.
	const drawn = new Map<number, boolean>()

	for (const row of rows) {
		byId.set(row.shape.id, row)
		drawn.set(row.shape.id, !row.shape.hidden && (row.parent === 0 || drawn.get(row.parent) === true))
	}

	const onSlide = selection.slide === slide ? selection.ids : []
	const chosenIds = [...onSlide, ...(extra?.with === selection ? extra.ids : [])].filter(id => byId.has(id))
	const chosen = new Set(chosenIds)
	const focusRow = (focusId === undefined ? undefined : byId.get(focusId)) ?? rows.find(row => chosen.has(row.shape.id)) ?? rows[0]
	const command = (op: DeckOp | undefined): void => {
		if (op !== undefined) void editor.command(op)
	}

	// The objects chosen: those drawn selected on the slide, the hidden ones held by the pane.
	const choose = (ids: readonly number[]): void => {
		const visible = ids.filter(id => drawn.get(id) === true)
		const hidden = ids.filter(id => drawn.get(id) !== true)

		if (visible.length > 0) selectionStore.set(visible)
		else selectionStore.clear()

		setExtra(hidden.length === 0 ? undefined : { ids: hidden, with: selectionStore.getSnapshot() })
	}
	const first = chosenIds[0]
	const level = first === undefined ? undefined : byId.get(first)?.parent
	const sameLevel = level !== undefined && chosenIds.every(id => byId.get(id)?.parent === level)
	const pick = (row: OutlineRow, event: { readonly shiftKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean }): void => {
		const from = anchor.current === undefined ? undefined : byId.get(anchor.current)

		if (event.shiftKey && from?.parent === row.parent) {
			const a = rows.indexOf(from)
			const b = rows.indexOf(row)

			choose(
				rows
					.slice(Math.min(a, b), Math.max(a, b) + 1)
					.filter(each => each.parent === row.parent)
					.map(each => each.shape.id)
			)

			return
		}

		anchor.current = row.shape.id

		if ((event.metaKey || event.ctrlKey) && sameLevel && level === row.parent) {
			choose(chosen.has(row.shape.id) ? chosenIds.filter(id => id !== row.shape.id) : [...chosenIds, row.shape.id])

			return
		}

		choose([row.shape.id])
	}
	const toggleHidden = (row: OutlineRow): void => {
		if (!editable || !outlineEditable(row.shape) || slide === undefined) return

		command(visibilityOp(slide, [row.shape.id], !row.shape.hidden))
	}
	const order = sameLevel ? (outlineLevel(shapes, level) ?? []).map(shape => shape.id) : []
	const canMove = (to: ZOrder): boolean =>
		editable && sameLevel && chosenIds.every(id => byId.get(id)?.shape.lock === undefined) && canZOrder(order, chosen, to)
	const move = (to: ZOrder): void => {
		if (slide !== undefined && canMove(to)) command(zOrderOp(slide, chosenIds, to))
	}
	const setCollapsed = (id: number, collapsed: boolean): void => {
		if (pane.collapsed.has(id) === collapsed) return

		const next = new Set(pane.collapsed)

		if (collapsed) next.add(id)
		else next.delete(id)

		store.setCollapsed(next)
	}
	const groupIds = (list: readonly OutlineShape[], into: number[] = []): number[] => {
		for (const shape of list)
			if (shape.children !== undefined) {
				into.push(shape.id)
				groupIds(shape.children, into)
			}

		return into
	}
	const rename = (row: OutlineRow): void => {
		if (editable && outlineEditable(row.shape)) setRenaming(row.shape.id)
	}
	const commitName = (row: OutlineRow, value: string): void => {
		setRenaming(undefined)
		setFocusId(row.shape.id)

		if (slide !== undefined) command(nameOp({ slide, id: row.shape.id }, value, row.shape.name))
	}
	const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
		const row = byId.get(Number(rowElement(event.target)?.dataset["outline"]))

		if (row === undefined || renaming !== undefined) return

		const index = rows.indexOf(row)
		const mod = event.ctrlKey || event.metaKey
		const group = row.shape.children !== undefined && row.shape.children.length > 0
		const run = (action: () => void): void => {
			event.preventDefault()
			// The editor's own keys (paging slides, its shortcuts) stay out of the pane.
			event.stopPropagation()
			action()
		}

		// The stacking order on the object actions' keys (Mod+Shift+F and Mod+Shift+B among them, PowerPoint's here).
		const to = Z_ORDER_KEYS.find(([command]) => matchesCombo(event, objectBindings[command], IS_MAC))?.[1]

		if (to !== undefined) {
			run(() => {
				move(to)
			})

			return
		}

		if (mod && event.shiftKey && !event.altKey) {
			if (event.code === "KeyS")
				run(() => {
					toggleHidden(row)
				})

			return
		}

		if (event.altKey && event.shiftKey && (event.code === "Digit1" || event.code === "Digit9")) {
			run(() => {
				store.setCollapsed(event.code === "Digit1" ? new Set(groupIds(shapes)) : new Set())
			})

			return
		}

		if (event.altKey || (mod && event.key !== " ")) return

		switch (event.key) {
			case "ArrowUp":
			case "ArrowDown": {
				const next = rows[index + (event.key === "ArrowUp" ? -1 : 1)]

				run(() => {
					if (next === undefined) return

					setFocusId(next.shape.id)

					if (event.shiftKey) {
						anchor.current = next.shape.id
						choose([next.shape.id])
					}
				})
				return
			}
			case "Home":
			case "End": {
				const next = event.key === "Home" ? rows[0] : rows.at(-1)

				run(() => {
					if (next !== undefined) setFocusId(next.shape.id)
				})
				return
			}
			case "ArrowLeft":
				run(() => {
					if (group && !pane.collapsed.has(row.shape.id)) setCollapsed(row.shape.id, true)
					else if (row.parent !== 0) setFocusId(row.parent)
				})
				return
			case "ArrowRight":
				run(() => {
					if (group && pane.collapsed.has(row.shape.id)) setCollapsed(row.shape.id, false)
					else if (group) setFocusId(rows[index + 1]?.shape.id)
				})
				return
			case " ":
			case "Enter":
				run(() => {
					if (event.shiftKey) choose(chosenIds.filter(id => id !== row.shape.id))
					else pick(row, { shiftKey: false, metaKey: mod, ctrlKey: mod })
				})
				return
			case "F2":
				run(() => {
					rename(row)
				})
				return
			case "Escape":
				run(onLeave)
				return
			default:
				break
		}

		// The numeric keypad's plus, minus and asterisk expand, collapse, and expand every group under it.
		if (event.code === "NumpadAdd" && group)
			run(() => {
				setCollapsed(row.shape.id, false)
			})
		else if (event.code === "NumpadSubtract" && group)
			run(() => {
				setCollapsed(row.shape.id, true)
			})
		else if (event.code === "NumpadMultiply" && group)
			run(() => {
				const under = new Set(groupIds([row.shape]))

				store.setCollapsed(new Set([...pane.collapsed].filter(id => !under.has(id))))
			})
	}
	const clearDrop = (): void => {
		dropRef.current?.removeAttribute("data-drop")
		dropRef.current = null
	}
	const placeOf = (event: DragEvent<HTMLElement>, element: HTMLElement): "above" | "below" => {
		const box = element.getBoundingClientRect()

		return event.clientY < box.top + box.height / 2 ? "above" : "below"
	}
	const dropTarget = (event: DragEvent<HTMLElement>): { row: OutlineRow; element: HTMLElement } | undefined => {
		const element = rowElement(event.target)
		const row = element === null ? undefined : byId.get(Number(element.dataset["outline"]))
		// Only onto a row of the dragged rows' own level.
		if (element === null || row === undefined || row.parent !== drag.current?.parent) return undefined

		return { row, element }
	}
	// Show All and Hide All, offered while they would change something.
	const showAll = slide === undefined ? undefined : visibilityAllOp(slide, shapes, false)
	const hideAll = slide === undefined ? undefined : visibilityAllOp(slide, shapes, true)

	return (
		<section
			data-preview-surface
			data-office-pane
			data-selection-pane=""
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
					{t("previewPptxSelectionTitle")}
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("previewPptxSelectionClose")}
					title={t("previewPptxSelectionClose")}
					onClick={() => {
						store.setOpen(false)
						onLeave()
					}}
				>
					<XIcon />
				</Button>
			</div>
			<div className="flex shrink-0 items-center gap-1 border-b border-border p-1">
				<Button
					variant="ghost"
					size="sm"
					disabled={!editable || showAll === undefined}
					onClick={() => {
						command(showAll)
					}}
				>
					{t("previewPptxSelectionShowAll")}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={!editable || hideAll === undefined}
					onClick={() => {
						command(hideAll)
					}}
				>
					{t("previewPptxSelectionHideAll")}
				</Button>
				<span className="flex-1" />
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("previewPptxBringForward")}
					title={t("previewPptxBringForward")}
					disabled={!canMove("forward")}
					onClick={() => {
						move("forward")
					}}
				>
					<ArrowUpIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("previewPptxSendBackward")}
					title={t("previewPptxSendBackward")}
					disabled={!canMove("backward")}
					onClick={() => {
						move("backward")
					}}
				>
					<ArrowDownIcon />
				</Button>
			</div>
			<p
				id={keysId}
				className="sr-only"
			>
				{selectionKeysHelp(t, objectBindings)}
			</p>
			<p
				className="sr-only"
				aria-live="polite"
			>
				{announce}
			</p>
			{outline === undefined ? (
				<p
					role="status"
					className="p-3 text-sm text-muted-foreground"
				>
					{t(pane.failed ? "previewPptxSelectionFailed" : "previewPptxSelectionLoading")}
				</p>
			) : rows.length === 0 ? (
				<p className="p-3 text-sm text-muted-foreground">{t("previewPptxSelectionEmpty")}</p>
			) : (
				// Pointer, keys and drops are handled here, once for the list.
				<div
					ref={treeRef}
					role="tree"
					aria-label={t("previewPptxSelectionList")}
					aria-describedby={keysId}
					aria-multiselectable
					className="min-h-0 flex-1 overflow-y-auto p-1"
					onClick={(event: MouseEvent<HTMLDivElement>) => {
						const element = rowElement(event.target)
						const row = element === null ? undefined : byId.get(Number(element.dataset["outline"]))

						if (row === undefined || renaming === row.shape.id) return

						const control = event.target instanceof Element ? event.target.closest("[data-outline-control]") : null

						if (control?.getAttribute("data-outline-control") === "eye") toggleHidden(row)
						else if (control?.getAttribute("data-outline-control") === "expand")
							setCollapsed(row.shape.id, !pane.collapsed.has(row.shape.id))
						else pick(row, event)

						setFocusId(row.shape.id)
					}}
					onDoubleClick={(event: MouseEvent<HTMLDivElement>) => {
						const row = byId.get(Number(rowElement(event.target)?.dataset["outline"]))
						const control = event.target instanceof Element ? event.target.closest("[data-outline-control]") : null

						if (row !== undefined && control === null) rename(row)
					}}
					onKeyDown={onKey}
					onDragStart={(event: DragEvent<HTMLDivElement>) => {
						const row = byId.get(Number(rowElement(event.target)?.dataset["outline"]))

						if (row === undefined) return

						// The chosen objects of its level move with it; alone otherwise.
						const ids = chosen.has(row.shape.id) && sameLevel && level === row.parent ? chosenIds : [row.shape.id]

						drag.current = { ids, parent: row.parent }
						event.dataTransfer.effectAllowed = "move"
						event.dataTransfer.setData(DRAG_TYPE, String(row.shape.id))
					}}
					onDragOver={(event: DragEvent<HTMLDivElement>) => {
						const target = dropTarget(event)

						if (target === undefined) {
							clearDrop()

							return
						}

						event.preventDefault()
						event.dataTransfer.dropEffect = "move"

						const place = placeOf(event, target.element)

						if (dropRef.current !== target.element || target.element.getAttribute("data-drop") !== place) {
							clearDrop()
							target.element.setAttribute("data-drop", place)
							dropRef.current = target.element
						}
					}}
					onDragEnd={() => {
						clearDrop()
						drag.current = undefined
					}}
					onDrop={(event: DragEvent<HTMLDivElement>) => {
						const target = dropTarget(event)
						const dragged = drag.current

						clearDrop()
						drag.current = undefined

						if (target === undefined || dragged === undefined || slide === undefined) return

						event.preventDefault()

						const siblings = outlineLevel(shapes, dragged.parent) ?? []
						const op = reorderOp(slide, siblings, dragged.ids, target.row.shape.id, placeOf(event, target.element))

						if (op !== undefined) {
							command(op)
							setAnnounce(t("previewPptxSelectionMoved"))
						}
					}}
				>
					{rows.map(row => {
						const shape = row.shape
						const name = outlineName(t, shape)
						const group = shape.children !== undefined && shape.children.length > 0
						const changeable = editable && outlineEditable(shape)
						const shown = drawn.get(shape.id) === true

						return (
							<div
								key={shape.id}
								role="treeitem"
								data-outline={shape.id}
								aria-level={row.depth + 1}
								aria-posinset={row.count - row.index}
								aria-setsize={row.count}
								aria-selected={chosen.has(shape.id)}
								aria-label={shape.hidden ? t("previewPptxSelectionHiddenRow", { name }) : name}
								{...(group ? { "aria-expanded": !pane.collapsed.has(shape.id) } : {})}
								tabIndex={shape.id === focusRow?.shape.id ? 0 : -1}
								draggable={changeable && renaming !== shape.id}
								style={{ paddingLeft: 4 + row.depth * INDENT_PX, height: ROW_PX }}
								className={cn(
									"flex cursor-default items-center gap-1 rounded-sm pr-1 text-xs outline-none select-none [contain-intrinsic-size:auto_28px] [content-visibility:auto]",
									"hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/30",
									"data-[drop=above]:shadow-[inset_0_2px_0_var(--color-primary)] data-[drop=below]:shadow-[inset_0_-2px_0_var(--color-primary)]",
									chosen.has(shape.id) && "bg-accent text-accent-foreground hover:bg-accent"
								)}
							>
								<span
									aria-hidden
									data-outline-control={group ? "expand" : undefined}
									className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
								>
									{group ? (
										pane.collapsed.has(shape.id) ? (
											<ChevronRightIcon className="size-3.5" />
										) : (
											<ChevronDownIcon className="size-3.5" />
										)
									) : null}
								</span>
								{renaming === shape.id ? (
									<RenameField
										label={t("previewPptxSelectionRename", { name })}
										initial={shape.name === "" ? name : shape.name}
										onDone={value => {
											if (value === undefined) {
												setRenaming(undefined)
												setFocusId(shape.id)
											} else commitName(row, value)
										}}
									/>
								) : (
									<span className={cn("min-w-0 flex-1 truncate", !shown && "text-muted-foreground")}>{name}</span>
								)}
								<button
									type="button"
									tabIndex={-1}
									data-outline-control="eye"
									aria-label={t(shape.hidden ? "previewPptxSelectionShow" : "previewPptxSelectionHide", { name })}
									title={t(shape.hidden ? "previewPptxSelectionShow" : "previewPptxSelectionHide", { name })}
									disabled={!changeable}
									aria-pressed={!shape.hidden}
									className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40"
								>
									{shape.hidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
								</button>
							</div>
						)
					})}
				</div>
			)}
		</section>
	)
}

// The Arrange tab's Selection Pane button (pressed while the pane is open).
export function SelectionPaneButton() {
	const { t } = useTranslation("preview")
	const store = usePresentationEditor()?.selectionPane
	const pane = useSelectionPane(store)

	if (store === undefined) return null

	return (
		<RibbonButton
			label={t("previewPptxSelectionPane")}
			icon={<LayersIcon />}
			pressed={pane.open}
			onClick={() => {
				store.toggle()
			}}
		/>
	)
}

// The rename box in place of a row's name: Enter or leaving it renames, Escape keeps the name.
function RenameField({ label, initial, onDone }: { label: string; initial: string; onDone: (value: string | undefined) => void }) {
	const done = useRef(false)
	const finish = (value: string | undefined): void => {
		if (done.current) return

		done.current = true
		onDone(value)
	}

	return (
		<Input
			aria-label={label}
			defaultValue={initial}
			autoFocus
			className="h-6 min-w-0 flex-1 px-1 py-0 text-xs leading-5"
			onFocus={event => {
				event.currentTarget.select()
			}}
			onClick={event => {
				event.stopPropagation()
			}}
			onDoubleClick={event => {
				event.stopPropagation()
			}}
			onKeyDown={event => {
				event.stopPropagation()

				if (event.key === "Enter") {
					event.preventDefault()
					finish(event.currentTarget.value)
				} else if (event.key === "Escape") {
					event.preventDefault()
					finish(undefined)
				}
			}}
			onBlur={event => {
				finish(event.currentTarget.value)
			}}
		/>
	)
}
