import { useEffect, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CellFlag, type SheetCommand, type SheetId } from "@filen/office/core/sheet"
import {
	ANNOTATION_DECORATORS,
	entryText,
	isMacPlatform,
	type SheetCellPointer,
	type SheetCellPointerResult,
	type SheetGridExtension,
	type SheetGridHandle,
	type SheetGridState,
	type SheetShortcut
} from "@filen/office/react/sheet"
import { ContextMenuItem } from "@/components/ui/context-menu"
import { AuthorNameDialog } from "@/features/office/components/authorNameDialog"
import { ensureAuthorName, useOfficeSettings } from "@/features/office/lib/officeSettings"
import type { TrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { useLatestRef } from "@/lib/useLatestRef"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { CardFrame, LinkBody, NoteBody, ThreadBody } from "@/features/spreadsheet/comments/annotationCards"
import {
	annotationOf,
	followsLink,
	linkAction,
	noteStart,
	type AnnotationKind,
	type SheetLink,
	type SheetNote,
	type SheetThread
} from "@/features/spreadsheet/comments/annotations.logic"
import { LinkDialog, type LinkRequest } from "@/features/spreadsheet/comments/linkDialog"
import { LinkTrustGate } from "@/features/spreadsheet/comments/linkTrustGate"
import { ShownNotes } from "@/features/spreadsheet/comments/shownNotes"

// Notes, threaded comments and hyperlinks in the sheet view: the cells' corner marks, a card while the pointer rests
// on an annotated cell (a tap, on touch), the card opened from the grid's menu or Shift+F2 to edit, the link dialog
// (Ctrl/Cmd+K) and Ctrl/Cmd+click following a link: through the shared link policy and the untrusted-domain
// confirmation, or to its place in the workbook. Notes and comments are written under the author name of the
// documents settings, asked for the first time one is needed.

// A pointer resting this long on a cell shows its card; leaving the cell (and the card) this long hides it.
const HOVER_SHOW_MS = 350
const HOVER_HIDE_MS = 250

interface Card {
	readonly kind: AnnotationKind
	readonly sheet: SheetId
	readonly row: number
	readonly col: number
	// "hover": read-only, while the pointer rests on the cell; "opened": from the menu or a key, editable.
	readonly mode: "hover" | "opened"
	// Opened: the active cell then. The card closes once the selection leaves it.
	readonly from?: { readonly row: number; readonly col: number }
}

type CardData = SheetNote | SheetThread | SheetLink | null

function cardKey(card: Card): string {
	return `${card.kind}:${String(card.sheet)}:${String(card.row)}:${String(card.col)}`
}

function cellKey(sheet: SheetId, row: number, col: number): string {
	return `${String(sheet)}:${String(row)}:${String(col)}`
}

export interface SheetAnnotationsOptions {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	handle: SheetHandle
	canEdit: boolean
	// A text file: it holds no notes or links.
	text: boolean
}

export function useSheetAnnotations({ grid, gridRef, handle, canEdit, text }: SheetAnnotationsOptions): SheetBodyExtension {
	const { t } = useTranslation("preview")
	const settings = useOfficeSettings()
	// The untrusted-domain confirmation, mounted once a link is in view (it reads the trusted domains).
	const linkGate = useRef<TrustedLinkGate | null>(null)
	const [linksShown, setLinksShown] = useState(false)
	const [onGate] = useState(() => (gate: TrustedLinkGate | null) => {
		linkGate.current = gate
	})
	const [card, setCard] = useState<Card | null>(null)
	const [data, setData] = useState<{ key: string; value: CardData } | null>(null)
	const [linkAsked, setLinkAsked] = useState<{ link: SheetLink | null; shown: string } | null>(null)
	const [asking, setAsking] = useState<((name: string | null) => void) | null>(null)
	const [mac] = useState(isMacPlatform)
	const timers = useRef<{ show: number; hide: number }>({ show: 0, hide: 0 })
	// Links read ahead (on hover, for the active cell) so a Ctrl/Cmd+click opens one inside the click's activation.
	const links = useRef(new Map<string, SheetLink | null>())
	const session = handle.session
	const { sheet, selection, layout } = grid
	const version = grid.state.version
	const active = selection.active
	const activeKind = annotationOf(grid.active.flags)
	const rightToLeft = layout?.rightToLeft ?? false
	const shownCells = layout?.extensions?.shownNotes
	const activeShown = (() => {
		for (let k = 0; shownCells !== undefined && k + 1 < shownCells.length; k += 2)
			if (shownCells[k] === active.row && shownCells[k + 1] === active.col) return true

		return false
	})()

	if (!linksShown && (grid.active.flags & CellFlag.HYPERLINK) !== 0 && !text) {
		setLinksShown(true)
	}

	// The session writes notes and comments under the documents settings' author name.
	useEffect(() => {
		if (settings.authorName !== null) {
			session.configure({ author: settings.authorName })
		}
	}, [session, settings.authorName])

	// What the card shows, read again after every change (by the card's cell: a card set again for the same cell
	// reads nothing again).
	const cardKind = card?.kind ?? null
	const cardSheet = card?.sheet ?? -1
	const cardRow = card?.row ?? -1
	const cardCol = card?.col ?? -1

	useEffect(() => {
		if (cardKind === null) {
			return undefined
		}

		let current = true
		const point = { sheet: cardSheet, row: cardRow, col: cardCol }
		const key = cardKey({ kind: cardKind, ...point, mode: "hover" })
		const read: Promise<CardData> =
			cardKind === "note"
				? session.query("note.get", point)
				: cardKind === "thread"
					? session.query("thread.get", point)
					: session.query("link.get", point)

		read.then(
			value => {
				if (current) {
					setData({ key, value })
				}
			},
			() => undefined
		)

		return () => {
			current = false
		}
	}, [session, cardKind, cardSheet, cardRow, cardCol, version])

	// Links read ahead are dropped with every change; the active cell's is read ahead again.
	const activeLinked = (grid.active.flags & CellFlag.HYPERLINK) !== 0 && !text
	const activeRow = active.row
	const activeCol = active.col

	useEffect(() => {
		links.current.clear()
	}, [sheet, version])

	useEffect(() => {
		const known = links.current

		if (!activeLinked) {
			return
		}

		const key = cellKey(sheet, activeRow, activeCol)

		session.query("link.get", { sheet, row: activeRow, col: activeCol }).then(
			link => {
				known.set(key, link)
			},
			() => undefined
		)
	}, [session, sheet, activeRow, activeCol, activeLinked, version])

	useEffect(() => {
		const current = timers.current

		return () => {
			window.clearTimeout(current.show)
			window.clearTimeout(current.hide)
		}
	}, [])

	// A sheet switch closes the card; an opened one closes once the selection leaves the cell it was opened from.
	if (
		card !== null &&
		(card.sheet !== sheet || (card.from !== undefined && (card.from.row !== active.row || card.from.col !== active.col)))
	) {
		setCard(null)
	}

	// A card opened over `row`, `col` (the active cell or a link's, Ctrl/Cmd+clicked).
	function opened(kind: AnnotationKind, row: number, col: number): Card {
		return { kind, sheet, row, col, mode: "opened", from: { row: active.row, col: active.col } }
	}

	// What a cell shows, as its tile holds it.
	function textAt(row: number, col: number): string {
		const found = grid.model.entry(sheet, row, col)

		return found === null ? "" : entryText(found.tile, found.entry)
	}

	async function readLink(of: SheetId, row: number, col: number): Promise<SheetLink | null> {
		const key = cellKey(of, row, col)
		const known = links.current.get(key)

		if (known !== undefined) {
			return known
		}

		const link = await session.query("link.get", { sheet: of, row, col }).catch(() => null)

		links.current.set(key, link)

		return link
	}

	function flagsAt(row: number, col: number): number {
		const found = grid.model.entry(sheet, row, col)

		return found === null ? 0 : (found.tile.flags[found.entry] ?? 0)
	}

	function exec(command: SheetCommand): Promise<boolean> {
		void grid.model.intent()

		return grid.model.command(command).then(
			result => result.ok,
			() => false
		)
	}

	// Runs `run` once there is an author name (asked for the first time).
	function withAuthor(run: (author: string) => void): void {
		void ensureAuthorName(
			() =>
				new Promise<string | null>(resolve => {
					setAsking(() => resolve)
				})
		).then(author => {
			if (author === null) {
				return
			}

			session.configure({ author })
			run(author)
		})
	}

	// Following a link: its place in the workbook, or its address through the policy and the trust confirmation.
	function follow(link: SheetLink | null): void {
		const action = linkAction(link)

		switch (action.kind) {
			case "open": {
				const gate = linkGate.current

				// Before the confirmation is there to ask, the link's card offers it.
				if (gate === null) {
					setLinksShown(true)

					return
				}

				if (!gate.intercept(action.href)) {
					window.open(action.href, "_blank", "noopener,noreferrer")
				}

				return
			}
			case "go": {
				const { place } = action
				const start = { row: place.range.startRow, col: place.range.startCol }
				const select = (): void => {
					gridRef.current?.goTo(start)

					if (place.range.endRow !== place.range.startRow || place.range.endCol !== place.range.startCol) {
						grid.model.choose({
							active: start,
							anchor: start,
							focus: { row: place.range.endRow, col: place.range.endCol },
							ranges: [place.range]
						})
					}
				}

				if (place.sheet === grid.model.getSnapshot().sheet) {
					select()

					return
				}

				grid.model.setSheet(place.sheet)

				// Once the sheet is on show (its layout read, a frame drawn), its place is selected.
				const handleRef = gridRef.current
				const off = handleRef?.onFrame(() => {
					if (grid.model.getSnapshot().sheet === place.sheet && grid.model.layout(place.sheet) !== null) {
						off?.()
						select()
					}
				})

				return
			}
			case "blocked":
				toast.error(t("previewSheetLinkBlocked"))

				return
			case "nowhere":
				toast.error(t("previewSheetLinkNowhere"))

				return
			case "unknown":
				return
		}
	}

	function hide(): void {
		window.clearTimeout(timers.current.show)
		window.clearTimeout(timers.current.hide)
		timers.current.hide = window.setTimeout(() => {
			setCard(current => (current?.mode === "hover" ? null : current))
		}, HOVER_HIDE_MS)
	}

	function hoverOn(row: number, col: number): void {
		const kind = annotationOf(flagsAt(row, col))

		window.clearTimeout(timers.current.show)

		if (kind === null || text) {
			hide()

			return
		}

		window.clearTimeout(timers.current.hide)

		if (kind === "link") {
			setLinksShown(true)
			void readLink(sheet, row, col)
		}

		timers.current.show = window.setTimeout(() => {
			setCard(current => (current?.mode === "opened" ? current : { kind, sheet, row, col, mode: "hover" }))
		}, HOVER_SHOW_MS)
	}

	function pointer(event: SheetCellPointer): SheetCellPointerResult {
		if (event.kind === "leave") {
			hide()

			return undefined
		}

		if (event.kind === "hover") {
			hoverOn(event.row, event.col)

			return undefined
		}

		const kind = annotationOf(flagsAt(event.row, event.col))

		if (!event.editing && (flagsAt(event.row, event.col) & CellFlag.HYPERLINK) !== 0 && followsLink(event, mac)) {
			const known = links.current.get(cellKey(sheet, event.row, event.col))

			// Read ahead on hover: opened inside the click. Otherwise read first (a pop-up blocker may hold a web link: the
			// card then offers it).
			if (known !== undefined) {
				follow(known)
			} else {
				void readLink(sheet, event.row, event.col).then(link => {
					if (linkAction(link).kind === "open") {
						setCard(opened("link", event.row, event.col))
					} else {
						follow(link)
					}
				})
			}

			return true
		}

		// A press elsewhere closes an opened card; a tap on an annotated cell shows its card (touch has no hover).
		if (card?.mode === "opened") {
			setCard(null)
		} else if (event.pointerType === "touch" && kind !== null && !text) {
			setCard({ kind, sheet, row: event.row, col: event.col, mode: "hover" })
		}

		return false
	}

	const pointerRef = useLatestRef(pointer)
	const [gridExtension] = useState<SheetGridExtension>(() => ({
		id: "annotations",
		decorators: ANNOTATION_DECORATORS,
		pointer: event => pointerRef.current(event)
	}))

	function open(kind: AnnotationKind): void {
		window.clearTimeout(timers.current.show)
		setCard(opened(kind, active.row, active.col))
	}

	function askLink(): void {
		void readLink(sheet, active.row, active.col).then(link => {
			setLinkAsked({ link: link?.formula === true ? null : link, shown: grid.active.text })
		})
	}

	// An edited link keeps the cells it covers (Excel edits the whole link); a new one goes on the selection.
	function applyLink(request: LinkRequest): void {
		const edited = linkAsked?.link?.range ?? null

		void exec({
			type: "link.set",
			sheet,
			ranges: edited === null ? selection.ranges : [edited],
			target: request.target,
			...(request.text !== undefined && { text: request.text }),
			...(request.tooltip !== undefined && { tooltip: request.tooltip })
		})
	}

	function shortcut(key: SheetShortcut): boolean {
		if (text) {
			return false
		}

		if (key === "hyperlink") {
			if (canEdit) {
				askLink()
			}

			return true
		}

		if (key === "note") {
			if (activeKind === "thread") {
				open("thread")
			} else if (activeKind === "note") {
				open("note")
			} else if (canEdit) {
				withAuthor(() => {
					open("note")
				})
			}

			return true
		}

		return false
	}

	const shown = card !== null && data !== null && data.key === cardKey(card) ? data.value : null
	const loaded = card !== null && data !== null && data.key === cardKey(card)
	// An opened card gives the keyboard back to the grid.
	const close = (): void => {
		if (card?.mode === "opened") {
			gridRef.current?.focus()
		}

		setCard(null)
	}
	let body = null

	if (card !== null && (loaded || card.mode === "opened")) {
		const cell = { row: card.row, col: card.col }

		if (card.kind === "note" && (shown !== null || card.mode === "opened")) {
			const note = shown as SheetNote | null

			body = (
				<CardFrame
					key={cardKey(card)}
					gridRef={gridRef}
					cell={cell}
					rightToLeft={rightToLeft}
					label={t("previewSheetNoteBy", { author: note?.author ?? settings.authorName ?? "" })}
					opened={card.mode === "opened"}
					onPointerEnter={() => {
						window.clearTimeout(timers.current.hide)
					}}
					onPointerLeave={hide}
					onClose={close}
				>
					<NoteBody
						// A note opened before its text is read waits for it.
						key={loaded ? "loaded" : "loading"}
						note={note}
						editing={card.mode === "opened" && canEdit && loaded}
						initial={noteStart(settings.authorName)}
						onCancel={close}
						onSave={value => {
							close()
							withAuthor(() => {
								void exec({ type: "note.set", sheet: card.sheet, row: card.row, col: card.col, text: value })
							})
						}}
					/>
				</CardFrame>
			)
		} else if (card.kind === "thread") {
			const thread = shown as SheetThread | null

			if (thread !== null || (card.mode === "opened" && canEdit)) {
				body = (
					<CardFrame
						key={cardKey(card)}
						gridRef={gridRef}
						cell={cell}
						rightToLeft={rightToLeft}
						label={t("previewSheetCommentThread", { author: thread?.comments[0]?.author ?? settings.authorName ?? "" })}
						opened={card.mode === "opened"}
						onPointerEnter={() => {
							window.clearTimeout(timers.current.hide)
						}}
						onPointerLeave={hide}
						onClose={close}
					>
						<ThreadBody
							thread={loaded ? thread : null}
							opened={card.mode === "opened" && loaded}
							canEdit={canEdit}
							onCancel={close}
							onPost={value => {
								withAuthor(() => {
									void exec({ type: "thread.add", sheet: card.sheet, row: card.row, col: card.col, text: value })
								})
							}}
							onEdit={(id, value) => {
								void exec({ type: "thread.edit", sheet: card.sheet, id, text: value })
							}}
							onDelete={id => {
								if (thread?.comments[0]?.id === id) {
									close()
								}

								void exec({ type: "thread.delete", sheet: card.sheet, id })
							}}
						/>
					</CardFrame>
				)
			}
		} else if (card.kind === "link" && loaded) {
			const link = shown as SheetLink | null

			body = (
				<CardFrame
					key={cardKey(card)}
					gridRef={gridRef}
					cell={cell}
					rightToLeft={rightToLeft}
					label={t("previewSheetLinkOpen")}
					opened={card.mode === "opened"}
					onPointerEnter={() => {
						window.clearTimeout(timers.current.hide)
					}}
					onPointerLeave={hide}
					onClose={close}
				>
					<LinkBody
						link={link}
						sheets={grid.sheets}
						mac={mac}
						canEdit={canEdit}
						onOpen={() => {
							close()
							follow(link)
						}}
						onEdit={() => {
							close()
							setLinkAsked({ link, shown: textAt(card.row, card.col) })
						}}
						onRemove={() => {
							close()
							void exec({
								type: "link.remove",
								sheet: card.sheet,
								ranges: [{ startRow: card.row, startCol: card.col, endRow: card.row, endCol: card.col }]
							})
						}}
					/>
				</CardFrame>
			)
		}
	}

	if (text) {
		return { id: "annotations" }
	}

	const linked = activeLinked

	return {
		id: "annotations",
		grid: gridExtension,
		ribbon: canEdit
			? {
					...(activeKind === "thread" || activeKind === "note"
						? {}
						: {
								newComment: () => {
									withAuthor(() => {
										open("thread")
									})
								}
							}),
					...(activeKind === "thread"
						? {}
						: {
								note: {
									exists: activeKind === "note",
									shown: activeShown,
									toggle: () => {
										void exec({ type: "note.show", sheet, row: active.row, col: active.col, shown: !activeShown })
									},
									remove: () => {
										void exec({ type: "note.delete", sheet, ranges: selection.ranges })
									}
								}
							})
				}
			: {},
		overlay: (
			<>
				<ShownNotes
					gridRef={gridRef}
					session={session}
					sheet={sheet}
					cells={shownCells}
					version={version}
					rightToLeft={rightToLeft}
				/>
				{body}
			</>
		),
		menuItems: (
			<>
				{activeKind === "thread" ? (
					<ContextMenuItem
						onClick={() => {
							open("thread")
						}}
					>
						{t("previewSheetCommentShow")}
					</ContextMenuItem>
				) : null}
				{canEdit && activeKind !== "thread" && activeKind !== "note" ? (
					<>
						<ContextMenuItem
							onClick={() => {
								withAuthor(() => {
									open("thread")
								})
							}}
						>
							{t("previewSheetCommentNew")}
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() => {
								withAuthor(() => {
									open("note")
								})
							}}
						>
							{t("previewSheetNoteInsert")}
						</ContextMenuItem>
					</>
				) : null}
				{canEdit && activeKind === "note" ? (
					<>
						<ContextMenuItem
							onClick={() => {
								open("note")
							}}
						>
							{t("previewSheetNoteEdit")}
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() => {
								void exec({ type: "note.show", sheet, row: active.row, col: active.col, shown: !activeShown })
							}}
						>
							{activeShown ? t("previewSheetNoteHide") : t("previewSheetNoteShow")}
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() => {
								void exec({ type: "note.delete", sheet, ranges: selection.ranges })
							}}
						>
							{t("previewSheetNoteDelete")}
						</ContextMenuItem>
					</>
				) : null}
				{canEdit && activeKind === "thread" ? (
					<ContextMenuItem
						onClick={() => {
							void session.query("thread.get", { sheet, row: active.row, col: active.col }).then(thread => {
								const root = thread?.comments[0]?.id

								if (root !== undefined) {
									void exec({ type: "thread.delete", sheet, id: root })
								}
							})
						}}
					>
						{t("previewSheetCommentDeleteThread")}
					</ContextMenuItem>
				) : null}
				{linked ? (
					<ContextMenuItem
						onClick={() => {
							follow(links.current.get(cellKey(sheet, active.row, active.col)) ?? null)
						}}
					>
						{t("previewSheetLinkOpen")}
					</ContextMenuItem>
				) : null}
				{canEdit ? (
					<ContextMenuItem onClick={askLink}>{linked ? t("previewSheetLinkEdit") : t("previewSheetLinkInsert")}</ContextMenuItem>
				) : null}
				{canEdit && linked ? (
					<ContextMenuItem
						onClick={() => {
							void exec({ type: "link.remove", sheet, ranges: selection.ranges })
						}}
					>
						{t("previewSheetLinkRemove")}
					</ContextMenuItem>
				) : null}
			</>
		),
		dialogs: (
			<>
				<LinkDialog
					open={linkAsked !== null}
					link={linkAsked?.link ?? null}
					shown={linkAsked?.shown ?? ""}
					sheets={grid.sheets}
					sheet={sheet}
					onClose={() => {
						setLinkAsked(null)
						// The keyboard goes back to the grid, which opened the dialog (Ctrl/Cmd+K or a card).
						gridRef.current?.focus()
					}}
					onApply={applyLink}
				/>
				<AuthorNameDialog
					open={asking !== null}
					pending={false}
					initialValue={settings.authorName}
					onOpenChange={next => {
						if (!next) {
							asking?.(null)
							setAsking(null)
						}
					}}
					onSubmit={name => {
						asking?.(name)
						setAsking(null)
					}}
				/>
				{linksShown ? <LinkTrustGate onGate={onGate} /> : null}
			</>
		),
		shortcut
	}
}
