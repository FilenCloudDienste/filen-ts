import { useEffect, useRef, useState } from "react"
import {
	DOCX_VIEWER_CAPABILITIES,
	clampZoom,
	fitWidthZoom,
	stepZoom,
	type DocxCapabilities,
	type DocxViewerCommand,
	type DocxViewerState
} from "../../dom/docx/viewer"
import { DOCX_FIND_LIMIT } from "../../dom/docx/protocol"
import type { DocxPagesHandle, DocxPagesProps } from "./DocxPages"
import { findMatchList, type DocxFindMatch } from "./find"
import type { DocxDocument } from "./store"

// Applies viewer commands to a DocxPages surface and reports its state, so an app's toolbar (or a native
// one across the DOM-component bridge) drives navigation, zoom and find without owning any of it.

export interface DocxViewerOptions {
	// Space between and around pages (px).
	readonly gap?: number
	readonly capabilities?: DocxCapabilities
	// Space kept right of the pages (px on screen), left out of fit-to-width.
	readonly aside?: number
}

export interface DocxViewer {
	readonly state: DocxViewerState
	readonly dispatch: (command: DocxViewerCommand) => void
	// Spread onto <DocxPages>.
	readonly pages: Pick<DocxPagesProps, "document" | "zoom" | "gap" | "ref" | "onPageChange" | "onViewportWidth" | "find" | "asideWidth">
}

interface FindState {
	readonly open: boolean
	readonly query: string
	readonly caseSensitive: boolean
	readonly wholeWord: boolean
	// Index into matches, or -1 until the first results pick one.
	readonly active: number
	readonly matches: readonly DocxFindMatch[]
	// More matched than `matches` holds.
	readonly capped: boolean
	// The page in view when the query was entered: the first match from there becomes current.
	readonly from: number
}

const CLOSED: FindState = {
	open: false,
	query: "",
	caseSensitive: false,
	wholeWord: false,
	active: -1,
	matches: [],
	capped: false,
	from: 0
}

export function useDocxViewer(document: DocxDocument, options: DocxViewerOptions = {}): DocxViewer {
	const gap = options.gap ?? 16
	const aside = Math.max(0, options.aside ?? 0)
	const pagesRef = useRef<DocxPagesHandle | null>(null)
	const [zoomMode, setZoomMode] = useState<"fitWidth" | number>("fitWidth")
	const [viewportWidth, setViewportWidth] = useState(0)
	const [page, setPage] = useState(0)
	const [find, setFind] = useState<FindState>(CLOSED)
	const pageWidth = document.pages[0]?.width ?? document.info?.pageWidth ?? 816
	const fitZoom = fitWidthZoom(viewportWidth - aside, pageWidth, gap)
	const zoom = zoomMode === "fitWidth" ? fitZoom : zoomMode
	const pendingScroll = useRef<DocxFindMatch | null>(null)
	const session = document.session
	const laidOut = document.pages.length
	const status = document.status
	const { open, query, caseSensitive, wholeWord } = find
	const searching = open && query.length > 0

	// The engine searches every page laid out so far, and again as more arrive. A newer query wins.
	useEffect(() => {
		if (!searching || session === undefined || laidOut === 0) return

		let current = true

		session
			.find(query, { caseSensitive, wholeWord })
			.then(found => {
				if (!current) return

				const all = findMatchList(found)
				const capped = all.length > DOCX_FIND_LIMIT
				const matches = capped ? all.slice(0, DOCX_FIND_LIMIT) : all

				setFind(previous => {
					if (
						previous.query !== query ||
						previous.caseSensitive !== caseSensitive ||
						previous.wholeWord !== wholeWord ||
						!previous.open
					)
						return previous

					let active = previous.active

					if (active < 0 && matches.length > 0) {
						const first = matches.findIndex(match => match.page >= previous.from)

						active = first < 0 ? 0 : first
						pendingScroll.current = matches[active] ?? null
					}

					return { ...previous, matches, capped, active: Math.min(active, matches.length - 1) }
				})
			})
			.catch(() => undefined)

		return () => {
			current = false
		}
	}, [searching, session, query, caseSensitive, wholeWord, laidOut, status])

	// A newly selected match scrolls into view once the state that holds it has rendered.
	useEffect(() => {
		const match = pendingScroll.current

		if (match !== null) {
			pendingScroll.current = null
			pagesRef.current?.scrollToMatch(match)
		}
	})

	const select = (step: 1 | -1): void => {
		const count = find.matches.length

		if (count === 0) return

		const next = ((((find.active < 0 ? 0 : find.active + step) % count) + count) % count) | 0

		pendingScroll.current = find.matches[next] ?? null
		setFind(previous => ({ ...previous, active: next }))
	}

	const dispatch = (command: DocxViewerCommand): void => {
		switch (command.type) {
			case "page.previous":
				pagesRef.current?.scrollToPage(page - 1)

				break
			case "page.next":
				pagesRef.current?.scrollToPage(page + 1)

				break
			case "page.goto":
				pagesRef.current?.scrollToPage(command.page)

				break
			case "zoom.in":
				setZoomMode(stepZoom(zoom, 1))

				break
			case "zoom.out":
				setZoomMode(stepZoom(zoom, -1))

				break
			case "zoom.set":
				setZoomMode(clampZoom(command.zoom))

				break
			case "zoom.by":
				// Against the latest state, so gestures faster than renders accumulate.
				setZoomMode(previous => clampZoom((previous === "fitWidth" ? fitZoom : previous) + command.delta))

				break
			case "zoom.fitWidth":
				setZoomMode("fitWidth")

				break
			case "find.open":
				setFind(previous => ({ ...previous, open: true }))

				break
			case "find.close":
				setFind(CLOSED)

				break
			case "find.query":
				setFind(previous => {
					const caseSensitive = command.caseSensitive ?? previous.caseSensitive
					const wholeWord = command.wholeWord ?? previous.wholeWord

					// The same search again keeps its results: nothing would run it anew.
					if (
						previous.open &&
						previous.query === command.query &&
						previous.caseSensitive === caseSensitive &&
						previous.wholeWord === wholeWord
					)
						return previous

					return {
						open: true,
						query: command.query,
						caseSensitive,
						wholeWord,
						active: -1,
						matches: [],
						capped: false,
						from: page
					}
				})

				break
			case "find.next":
				select(1)

				break
			case "find.previous":
				select(-1)

				break
		}
	}

	const active = find.matches.length === 0 ? -1 : Math.max(find.active, 0)
	const state: DocxViewerState = {
		status,
		capabilities: options.capabilities ?? DOCX_VIEWER_CAPABILITIES,
		page,
		pageCount: Math.max(document.pageCount, 1),
		pageCountFinal: status === "ready",
		zoom,
		zoomMode: zoomMode === "fitWidth" ? "fitWidth" : "custom",
		find: { open, query, caseSensitive, wholeWord, count: find.matches.length, capped: find.capped, active }
	}

	return {
		state,
		dispatch,
		pages: {
			document,
			zoom,
			gap,
			ref: pagesRef,
			onPageChange: setPage,
			onViewportWidth: setViewportWidth,
			find: open ? { matches: find.matches, active } : undefined,
			asideWidth: aside
		}
	}
}
