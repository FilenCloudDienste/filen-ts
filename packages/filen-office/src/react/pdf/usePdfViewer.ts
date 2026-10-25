import { useEffect, useRef, useState } from "react"
import {
	mostVisiblePage,
	pdfFitScale,
	pdfPageRotation,
	pdfRotate,
	pdfStepZoomScale,
	pdfWheelZoomScale,
	pdfZoomPercent,
	clampPdfScale,
	PdfFinder,
	PDF_BASE_SCALE,
	PDF_FIND_INTS,
	type PdfFindResult,
	type PdfViewerCommand,
	type PdfViewerState
} from "../../dom/pdf/index"
import type { Slicing } from "../../core/slicing"
import type { PdfPagesBinding } from "./PdfPages"
import type { PdfDomDocument } from "./types"

// The viewer over an open document: page tracking, navigation, zoom, rotation and find, driven by
// PdfViewerCommands.
// Render `<PdfPages {...viewer.pages} />` with it.

export interface PdfViewer {
	readonly state: PdfViewerState
	readonly dispatch: (command: PdfViewerCommand) => void
	readonly pages: PdfPagesBinding
}

interface FindState {
	readonly open: boolean
	readonly query: string
	readonly caseSensitive: boolean
	readonly result: PdfFindResult | null
	readonly active: number
	// The page in view when the query was searched: the first match from it on becomes active.
	readonly from: number
	readonly reveal: number
}

const CLOSED: FindState = { open: false, query: "", caseSensitive: false, result: null, active: -1, from: 1, reveal: 0 }

// The search over the document's text gives the page a turn every slice.
const FIND_SLICING: Slicing = {
	pause: () =>
		new Promise(resolve => {
			setTimeout(resolve, 0)
		}),
	sliceMs: 8,
	now: () => performance.now()
}

interface Fit {
	readonly mode: "fitWidth" | "fitPage"
	// The page whose size is fitted (the one in view when asked).
	readonly page: number
}

function reducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function usePdfViewer(document: PdfDomDocument): PdfViewer {
	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const elements = useRef(new Map<number, HTMLElement>())
	const ratios = useRef(new Map<number, number>())
	const [page, setPage] = useState(1)
	const [scale, setScale] = useState(PDF_BASE_SCALE)
	const [fit, setFit] = useState<Fit | null>(null)
	const [rotation, setRotation] = useState(0)
	// The page brought back into view once a fit, a preset or a turn has laid the pages out again.
	const keepRef = useRef<number | null>(null)
	const [find, setFind] = useState<FindState>(CLOSED)
	const [finder, setFinder] = useState(() => ({ document, finder: new PdfFinder(document, FIND_SLICING) }))
	const pageCount = document.numPages
	const searching = find.open && find.query.length > 0 ? find.query : null
	const caseSensitive = find.caseSensitive

	if (finder.document !== document) setFinder({ document, finder: new PdfFinder(document, FIND_SLICING) })

	// Ctrl/Cmd+wheel zooms: a native, non-passive listener, as React's wheel handler is passive and could not stop
	// the browser's own page zoom. A plain wheel scrolls.
	useEffect(() => {
		const scroller = scrollerRef.current

		if (scroller === null) return

		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) return

			event.preventDefault()
			keepRef.current = null
			setFit(null)
			setScale(previous => pdfWheelZoomScale(previous, event.deltaY))
		}

		scroller.addEventListener("wheel", onWheel, { passive: false })

		return () => {
			scroller.removeEventListener("wheel", onWheel)
		}
	}, [])

	// A newer query (or closing) aborts the search under way.
	useEffect(() => {
		if (searching === null) return

		const signal = { aborted: false }
		const current = finder.finder

		void current.search(searching, caseSensitive, signal).then(result => {
			if (result === null || signal.aborted) return

			setFind(previous => {
				if (!previous.open || previous.query !== searching || previous.caseSensitive !== caseSensitive) return previous

				let active = -1

				for (let match = 0; match < result.matches.length / PDF_FIND_INTS; match++) {
					if ((result.matches[match * PDF_FIND_INTS] ?? 0) >= previous.from) {
						active = match

						break
					}
				}

				if (active < 0 && result.matches.length > 0) active = 0

				return { ...previous, result, active, reveal: active < 0 ? previous.reveal : previous.reveal + 1 }
			})
		})

		return () => {
			signal.aborted = true
		}
	}, [finder, searching, caseSensitive])

	// A fitted zoom follows the view's size and the turn: the fitted page's size is read once per fit, and a
	// ResizeObserver refits from it.
	useEffect(() => {
		const scroller = scrollerRef.current

		if (fit === null || scroller === null) return

		let live = true
		let size: { width: number; height: number } | null = null

		const apply = (): void => {
			const fitted = size

			if (live && fitted !== null) {
				setScale(previous =>
					pdfFitScale(fit.mode, fitted.width, fitted.height, scroller.clientWidth, scroller.clientHeight, previous)
				)
			}
		}

		document.getPage(fit.page).then(
			proxy => {
				const viewport = proxy.getViewport({ scale: 1, rotation: pdfPageRotation(proxy.rotate, rotation) })

				size = { width: viewport.width, height: viewport.height }
				apply()
			},
			() => {
				// An unreadable page leaves the zoom as it is.
			}
		)

		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null

		observer?.observe(scroller)

		return () => {
			live = false
			observer?.disconnect()
		}
	}, [document, fit, rotation])

	const goToPage = (target: number, smooth: boolean): void => {
		const clamped = Math.min(Math.max(1, Math.round(target)), pageCount)

		elements.current.get(clamped)?.scrollIntoView({ behavior: smooth && !reducedMotion() ? "smooth" : "auto", block: "start" })
	}

	useEffect(() => {
		const keep = keepRef.current

		if (keep !== null) {
			keepRef.current = null
			elements.current.get(keep)?.scrollIntoView({ block: "start" })
		}
	}, [scale, rotation])

	const shownPage = Math.min(page, pageCount)

	const dispatch = (command: PdfViewerCommand): void => {
		switch (command.type) {
			case "page.previous":
				goToPage(page - 1, true)
				break
			case "page.next":
				goToPage(page + 1, true)
				break
			case "page.first":
				goToPage(1, false)
				break
			case "page.last":
				goToPage(pageCount, false)
				break
			case "page.goto":
				goToPage(command.page, true)
				break
			case "zoom.in":
				keepRef.current = null
				setFit(null)
				setScale(previous => pdfStepZoomScale(previous, 1))
				break
			case "zoom.out":
				keepRef.current = null
				setFit(null)
				setScale(previous => pdfStepZoomScale(previous, -1))
				break
			case "zoom.set":
				keepRef.current = shownPage
				setFit(null)
				setScale(clampPdfScale(command.scale))
				break
			case "zoom.by":
				keepRef.current = null
				setFit(null)
				setScale(previous => clampPdfScale(previous + command.delta))
				break
			case "zoom.fitWidth":
			case "zoom.fitPage":
				keepRef.current = shownPage
				setFit({ mode: command.type === "zoom.fitWidth" ? "fitWidth" : "fitPage", page: shownPage })
				break
			case "rotate.clockwise":
			case "rotate.counterClockwise":
				keepRef.current = shownPage
				setRotation(previous => pdfRotate(previous, command.type === "rotate.clockwise" ? 1 : -1))
				break
			case "find.open":
				setFind(previous => (previous.open ? previous : { ...CLOSED, open: true, caseSensitive: previous.caseSensitive }))
				break
			case "find.close":
				setFind(previous => ({ ...CLOSED, caseSensitive: previous.caseSensitive, reveal: previous.reveal }))
				break
			case "find.query": {
				const nextCase = command.caseSensitive ?? find.caseSensitive

				if (command.query === find.query && nextCase === find.caseSensitive && find.open) break

				setFind(previous => ({
					...previous,
					open: true,
					query: command.query,
					caseSensitive: nextCase,
					result: null,
					active: -1,
					from: page
				}))
				break
			}
			case "find.next":
			case "find.previous": {
				const step = command.type === "find.next" ? 1 : -1

				setFind(previous => {
					const count = previous.result === null ? 0 : previous.result.matches.length / PDF_FIND_INTS

					if (count === 0) return previous

					return { ...previous, active: (previous.active + step + count) % count, reveal: previous.reveal + 1 }
				})
				break
			}
		}
	}

	const onVisible = (visiblePage: number, ratio: number): void => {
		ratios.current.set(visiblePage, ratio)

		const visible = mostVisiblePage(ratios.current)

		if (visible !== null) setPage(visible)
	}

	const registerPage = (registered: number, element: HTMLElement | null): void => {
		if (element === null) elements.current.delete(registered)
		else elements.current.set(registered, element)
	}

	const onNavigate = (target: number): void => {
		goToPage(target, false)
	}

	const count = find.result === null ? 0 : find.result.matches.length / PDF_FIND_INTS
	const state: PdfViewerState = {
		page: shownPage,
		pageCount,
		scale,
		zoom: pdfZoomPercent(scale),
		zoomMode: fit?.mode ?? "custom",
		rotation,
		find: {
			open: find.open,
			query: find.query,
			caseSensitive: find.caseSensitive,
			done: find.query.length === 0 || find.result !== null,
			count,
			capped: find.result?.capped ?? false,
			active: find.active
		}
	}

	return {
		state,
		dispatch,
		pages: {
			document,
			scale,
			rotation,
			find: { matches: find.open ? (find.result?.matches ?? null) : null, active: find.active, reveal: find.reveal },
			scrollerRef,
			onVisible,
			registerPage,
			onNavigate
		}
	}
}
