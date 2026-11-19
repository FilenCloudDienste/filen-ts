import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { SheetId, SheetSessionApi } from "@filen/office/core/sheet"
import type { GridRect, SheetGridHandle } from "@filen/office/react/sheet"
import { cardPlace, type SheetNote } from "@/features/spreadsheet/comments/annotations.logic"

// Notes shown all the time (Excel's "Show note"): each in a small card beside its cell, read-only, kept there as the
// grid scrolls. A sheet may show thousands, so only the cells on screen get a card: one frame listener finds them and
// places every card (all layout reads, then all writes), and only a mounted card's text is read, once per change.

interface Point {
	readonly row: number
	readonly col: number
}

const NONE: readonly Point[] = []

function pointKey(sheet: SheetId, point: Point): string {
	return `${String(sheet)}:${String(point.row)}:${String(point.col)}`
}

// The text read for each card, by cell, with the grid state version it was read at.
interface NoteCache {
	readonly session: SheetSessionApi
	readonly read: Map<string, number>
}

export function ShownNotes({
	gridRef,
	session,
	sheet,
	cells,
	version,
	rightToLeft
}: {
	gridRef: RefObject<SheetGridHandle | null>
	session: SheetSessionApi
	sheet: SheetId
	// Row, col pairs (the layout's shownNotes).
	cells: Uint32Array | undefined
	version: number
	rightToLeft: boolean
}) {
	const { t } = useTranslation("preview")
	// The cells on screen, as the last frame found them; set only when that set changes, never per frame.
	const [visible, setVisible] = useState<{ sheet: SheetId; points: readonly Point[] }>({ sheet, points: NONE })
	const [notes, setNotes] = useState<ReadonlyMap<string, SheetNote>>(() => new Map())
	const cache = useRef<NoteCache | null>(null)
	const nodes = useRef(new Map<string, HTMLDivElement>())
	const shownKey = useRef("")
	const points = visible.sheet === sheet ? visible.points : NONE

	useLayoutEffect(() => {
		const grid = gridRef.current

		if (grid === null || cells === undefined || cells.length < 2) {
			if (shownKey.current !== "") {
				shownKey.current = ""
				setVisible({ sheet, points: NONE })
			}

			return undefined
		}

		const frame = (): void => {
			const onScreen: { point: Point; rect: GridRect; key: string }[] = []

			for (let k = 0; k + 1 < cells.length; k += 2) {
				const point = { row: cells[k] ?? 0, col: cells[k + 1] ?? 0 }
				const rect = grid.cellRect(point)

				if (rect !== null) onScreen.push({ point, rect, key: pointKey(sheet, point) })
			}

			const key = onScreen.map(entry => entry.key).join("|")

			if (key !== shownKey.current) {
				shownKey.current = key
				setVisible({ sheet, points: onScreen.map(entry => entry.point) })
			}

			// Every read first, then every write: one layout per frame, however many cards.
			const placed: { node: HTMLDivElement; at: { left: number; top: number } }[] = []

			for (const entry of onScreen) {
				const node = nodes.current.get(entry.key)

				if (node === undefined) continue

				const layer = node.offsetParent
				const bounds =
					layer instanceof HTMLElement
						? { width: layer.clientWidth, height: layer.clientHeight }
						: { width: window.innerWidth, height: window.innerHeight }

				placed.push({ node, at: cardPlace(entry.rect, node.offsetWidth, node.offsetHeight, bounds, rightToLeft) })
			}

			for (const { node, at } of placed) {
				node.style.visibility = "visible"
				node.style.transform = `translate(${String(Math.round(at.left))}px, ${String(Math.round(at.top))}px)`
			}
		}

		frame()

		const unframe = grid.onFrame(frame)
		// A card that grows (its text read) is placed again.
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(frame)

		for (const node of nodes.current.values()) observer?.observe(node)

		return () => {
			unframe()
			observer?.disconnect()
		}
		// `points`: cards just mounted are placed before they paint, and observed.
	}, [gridRef, cells, sheet, rightToLeft, points])

	// Each mounted card's text, read once per change of the sheet; a card scrolled away and back reads nothing again.
	useEffect(() => {
		if (cache.current?.session !== session) {
			cache.current = { session, read: new Map() }
		}

		const read = cache.current.read

		for (const point of points) {
			const key = pointKey(sheet, point)

			if (read.get(key) === version) continue

			read.set(key, version)
			session.query("note.get", { sheet, row: point.row, col: point.col }).then(
				found => {
					// A later read for the cell owns it.
					if (read.get(key) !== version) return

					setNotes(previous => {
						const known = previous.get(key)

						if (found === null ? known === undefined : known?.text === found.text && known.author === found.author) {
							return previous
						}

						const next = new Map(previous)

						if (found === null) next.delete(key)
						else next.set(key, found)

						return next
					})
				},
				() => {
					// Read again the next time it is on screen.
					if (read.get(key) === version) read.delete(key)
				}
			)
		}
	}, [session, sheet, version, points])

	return (
		<>
			{points.map(point => {
				const key = pointKey(sheet, point)
				const note = notes.get(key)
				const author = note?.author ?? ""

				return (
					<div
						key={key}
						ref={node => {
							if (node === null) {
								return undefined
							}

							nodes.current.set(key, node)

							return () => {
								nodes.current.delete(key)
							}
						}}
						role="note"
						aria-label={t("previewSheetNoteBy", { author: author === "" ? t("previewSheetUnknownAuthor") : author })}
						className="pointer-events-none invisible absolute top-0 left-0 max-h-40 w-48 overflow-hidden rounded-xl bg-popover p-2 text-xs break-words whitespace-pre-wrap text-popover-foreground shadow-md ring-1 ring-foreground/5 dark:ring-foreground/10"
					>
						{note?.text ?? ""}
					</div>
				)
			})}
		</>
	)
}
