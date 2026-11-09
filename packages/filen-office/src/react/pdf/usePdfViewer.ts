import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
	pdfFitScale,
	pdfPageInView,
	pdfPageRotation,
	pdfRotate,
	pdfStepZoomScale,
	pdfWheelZoomScale,
	pdfZoomPercent,
	clampPdfScale,
	PdfFinder,
	PDF_BASE_SCALE,
	PDF_FIND_INTS,
	type PdfDestination,
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
	// "auto": the opening zoom (pdfFitScale), shown as a custom percent.
	readonly mode: "fitWidth" | "fitPage" | "auto"
	// The page whose size is fitted (the one in view when asked).
	readonly page: number
}

const OPENING_FIT: Fit = { mode: "auto", page: 1 }

// How long a Next/Previous target stands as the page to step from while its scroll runs: a target that never
// becomes the page most in view (a last page shorter than the view) expires after it.
const NAVIGATION_SETTLE_MS = 1000

// A point of the view (from the scroller's top-left) as fractions of the page under it, kept there across a zoom.
interface ZoomAnchor {
	readonly page: number
	readonly fx: number
	readonly fy: number
	readonly viewX: number
	readonly viewY: number
}

// The page under the point is the first ending below it (a binary search: O(log n) boxes read); a point in the
// gap above a page belongs to it, with a fraction just under 0. Null while the pages are not laid out.
function zoomAnchor(scroller: HTMLElement, elements: ReadonlyMap<number, HTMLElement>, viewX: number, viewY: number): ZoomAnchor | null {
	const view = scroller.getBoundingClientRect()
	const y = view.top + viewY
	let low = 1
	let high = elements.size

	while (low < high) {
		const middle = (low + high) >>> 1
		const box = elements.get(middle)?.getBoundingClientRect()

		if (box === undefined) return null

		if (box.bottom <= y) low = middle + 1
		else high = middle
	}

	const box = elements.get(low)?.getBoundingClientRect()

	if (box === undefined || box.width <= 0 || box.height <= 0) return null

	return { page: low, fx: (view.left + viewX - box.left) / box.width, fy: (y - box.top) / box.height, viewX, viewY }
}

function restoreAnchor(scroller: HTMLElement, element: HTMLElement, anchor: ZoomAnchor): void {
	const view = scroller.getBoundingClientRect()
	const box = element.getBoundingClientRect()

	scroller.scrollTop += box.top + anchor.fy * box.height - (view.top + anchor.viewY)
	scroller.scrollLeft += box.left + anchor.fx * box.width - (view.left + anchor.viewX)
}

function centreAnchor(scroller: HTMLElement, elements: ReadonlyMap<number, HTMLElement>): ZoomAnchor | null {
	return zoomAnchor(scroller, elements, scroller.clientWidth / 2, scroller.clientHeight / 2)
}

function reducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function usePdfViewer(document: PdfDomDocument): PdfViewer {
	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const elements = useRef(new Map<number, HTMLElement>())
	const [page, setPage] = useState(1)
	const [scale, setScale] = useState(PDF_BASE_SCALE)
	// A document opens fitted to the view (narrow views) or at 100 %.
	const [fit, setFit] = useState<Fit | null>(OPENING_FIT)
	const [rotation, setRotation] = useState(0)
	// The page brought back to its start once a turn has laid the pages out again.
	const keepRef = useRef<number | null>(null)
	// The point a zoom keeps in place (the pointer's for Ctrl+wheel, else the view's centre). Written by every
	// scale change, so a zoom that changed nothing leaves no stale anchor for the next.
	const anchorRef = useRef<ZoomAnchor | null>(null)
	// The last Next/Previous/go-to target while its scroll runs: the next step counts from it, not from the page
	// most in view, which lags a smooth scroll.
	const pendingRef = useRef<{ readonly page: number; readonly until: number } | null>(null)
	// Bumped by every navigation, so a destination whose page loads late does not override a newer one.
	const navigation = useRef(0)
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

		// The user scrolling takes over from a pending Next/Previous target.
		const onPointerDown = (): void => {
			pendingRef.current = null
		}

		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) {
				pendingRef.current = null

				return
			}

			event.preventDefault()

			const view = scroller.getBoundingClientRect()

			keepRef.current = null
			// Read before the commit, so several wheel steps in one frame all measure the same layout.
			anchorRef.current = zoomAnchor(scroller, elements.current, event.clientX - view.left, event.clientY - view.top)
			setFit(null)
			setScale(previous => pdfWheelZoomScale(previous, event.deltaY))
		}

		scroller.addEventListener("wheel", onWheel, { passive: false })
		scroller.addEventListener("pointerdown", onPointerDown, { passive: true })

		return () => {
			scroller.removeEventListener("wheel", onWheel)
			scroller.removeEventListener("pointerdown", onPointerDown)
		}
	}, [])

	// The page shown is the one taking the most of the view, measured from the page boxes once a frame after a
	// scroll or a layout change (a zoom, a turn, a page's size arriving), not from margin-inflated observer ratios.
	useEffect(() => {
		const scroller = scrollerRef.current

		if (scroller === null) return

		let frame = 0

		const measure = (): void => {
			frame = 0

			const view = scroller.getBoundingClientRect()
			const visible = pdfPageInView(
				elements.current.size,
				target => {
					const box = elements.current.get(target)?.getBoundingClientRect()

					return box === undefined ? null : [box.top, box.bottom]
				},
				view.top,
				view.bottom
			)

			if (visible === null) return

			if (pendingRef.current?.page === visible) pendingRef.current = null

			setPage(visible)
		}

		const schedule = (): void => {
			if (frame === 0) frame = requestAnimationFrame(measure)
		}

		scroller.addEventListener("scroll", schedule, { passive: true })

		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null

		observer?.observe(scroller)

		if (scroller.firstElementChild !== null) observer?.observe(scroller.firstElementChild)

		schedule()

		return () => {
			scroller.removeEventListener("scroll", schedule)
			observer?.disconnect()
			cancelAnimationFrame(frame)
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
				// The view's centre stays put, unless the view is at the document's start (opening, or a fit there).
				anchorRef.current = scroller.scrollTop > 0 || scroller.scrollLeft > 0 ? centreAnchor(scroller, elements.current) : null
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

	// `left`/`top` (PDF user space) put a destination's point at the view's top-left corner; without `top` the
	// page's top goes there. The point needs the page's viewport, read only now: a newer navigation while it
	// loads wins.
	const goToPage = (target: number, smooth: boolean, left: number | null = null, top: number | null = null): void => {
		const clamped = Math.min(Math.max(1, Math.round(target)), pageCount)
		const sequence = ++navigation.current
		const element = elements.current.get(clamped)
		const behavior: ScrollBehavior = smooth && !reducedMotion() ? "smooth" : "auto"

		if (element === undefined) return

		pendingRef.current = { page: clamped, until: performance.now() + NAVIGATION_SETTLE_MS }

		if (top === null) {
			element.scrollIntoView({ behavior, block: "start" })

			return
		}

		const at = scale
		const turn = rotation

		document.getPage(clamped).then(
			proxy => {
				const scroller = scrollerRef.current

				if (navigation.current !== sequence || scroller === null) return

				const [x, y] = proxy
					.getViewport({ scale: at, rotation: pdfPageRotation(proxy.rotate, turn) })
					.convertToViewportPoint(left ?? 0, top)
				const box = element.getBoundingClientRect()
				const view = scroller.getBoundingClientRect()
				const options: ScrollToOptions = {
					top: box.top - view.top - scroller.clientTop + scroller.scrollTop + element.clientTop + (typeof y === "number" ? y : 0),
					behavior
				}

				// Across only when the page is wider than the view: a narrower one stays where the layout centres it.
				if (left !== null && typeof x === "number" && box.width > scroller.clientWidth) {
					options.left = box.left - view.left - scroller.clientLeft + scroller.scrollLeft + element.clientLeft + x
				}

				scroller.scrollTo(options)
			},
			() => {
				// An unreadable page is still a page to go to.
				if (navigation.current === sequence) element.scrollIntoView({ behavior, block: "start" })
			}
		)
	}

	// Before paint, once the pages are laid out at the new scale or turn: a turn brings the page in view back to
	// its start, a zoom puts its anchor back where it was in the view.
	useLayoutEffect(() => {
		const keep = keepRef.current
		const anchor = anchorRef.current
		const scroller = scrollerRef.current

		keepRef.current = null
		anchorRef.current = null

		if (keep !== null) {
			elements.current.get(keep)?.scrollIntoView({ block: "start" })

			return
		}

		const element = anchor === null ? undefined : elements.current.get(anchor.page)

		if (anchor !== null && element !== undefined && scroller !== null) restoreAnchor(scroller, element, anchor)
	}, [scale, rotation])

	const shownPage = Math.min(page, pageCount)

	// The page a Next/Previous steps from: the target still scrolling into view, else the page in view.
	const stepFrom = (): number => {
		const pending = pendingRef.current

		return pending !== null && performance.now() < pending.until ? pending.page : page
	}

	// Every scale change records where the view's centre is, so the zoom keeps it there.
	const anchorCentre = (): void => {
		const scroller = scrollerRef.current

		keepRef.current = null
		anchorRef.current = scroller === null ? null : centreAnchor(scroller, elements.current)
	}

	const dispatch = (command: PdfViewerCommand): void => {
		switch (command.type) {
			case "page.previous":
				goToPage(stepFrom() - 1, true)
				break
			case "page.next":
				goToPage(stepFrom() + 1, true)
				break
			case "page.first":
				goToPage(1, false)
				break
			case "page.last":
				goToPage(pageCount, false)
				break
			case "page.goto":
				goToPage(command.page, true, command.left ?? null, command.top ?? null)
				break
			case "zoom.in":
				anchorCentre()
				setFit(null)
				setScale(previous => pdfStepZoomScale(previous, 1))
				break
			case "zoom.out":
				anchorCentre()
				setFit(null)
				setScale(previous => pdfStepZoomScale(previous, -1))
				break
			case "zoom.set":
				anchorCentre()
				setFit(null)
				setScale(clampPdfScale(command.scale))
				break
			case "zoom.by":
				anchorCentre()
				setFit(null)
				setScale(previous => clampPdfScale(previous + command.delta))
				break
			case "zoom.fitWidth":
			case "zoom.fitPage":
				// The fit's own effect anchors the view's centre once it knows the scale.
				setFit({ mode: command.type === "zoom.fitWidth" ? "fitWidth" : "fitPage", page: shownPage })
				break
			case "rotate.clockwise":
			case "rotate.counterClockwise":
				keepRef.current = shownPage
				anchorRef.current = null
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

	const registerPage = (registered: number, element: HTMLElement | null): void => {
		if (element === null) elements.current.delete(registered)
		else elements.current.set(registered, element)
	}

	const onNavigate = (to: PdfDestination): void => {
		goToPage(to.page, false, to.left, to.top)
	}

	const count = find.result === null ? 0 : find.result.matches.length / PDF_FIND_INTS
	const state: PdfViewerState = {
		page: shownPage,
		pageCount,
		scale,
		zoom: pdfZoomPercent(scale),
		zoomMode: fit === null || fit.mode === "auto" ? "custom" : fit.mode,
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
			registerPage,
			onNavigate
		}
	}
}
