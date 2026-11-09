import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import {
	presentationActions,
	showKeyCommand,
	type PresentationActionActivator,
	type PresentationActionPolicy,
	type PresentationDocument,
	type PresentationJump,
	type PresentationStore,
	type ShowFrom
} from "@filen/office/react/presentation"
import { usePresenter } from "@/features/presentation/components/presenter/usePresenter"
import { DeckSlideShow } from "@/features/presentation/components/slideshow/deckSlideShow"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { isSafeAbsoluteHref } from "@/lib/safeUrl"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { log } from "@/lib/log"
import { SetUpShowHost } from "@/features/presentation/components/slideshow/setUpHost"
import {
	focusByRibbonRule,
	ribbonFocusTarget,
	takeRibbonOrigin,
	type RibbonOrigin
} from "@/features/presentation/components/ribbon/ribbonDialogs"
import { usePresentationShowBindings } from "@/features/presentation/lib/keymap/show"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

// The deck's links, jumps and slide show, as the presentation viewer and editor share them: links on the slide are
// judged when clicked, a refused action says so for a moment, and the show runs over the whole page (in full screen
// where the browser allows it), with the presenter view when it is asked for.

// How long the note about a refused action stays.
const REFUSED_NOTE_MS = 4000

// How long after Escape closed the show menu the browser may leave full screen for that same key.
const MENU_ESCAPE_MS = 1000

// The ribbon command a show is started from (undefined: none, as for a key).
function showOrigin(): RibbonOrigin | undefined {
	const origin = takeRibbonOrigin()

	return origin.control === null && origin.popup === null ? undefined : origin
}

// Where focus goes when the show ends: the ribbon command that started it by the ribbon's rule, else the slide.
function endFocus(origin: RefObject<RibbonOrigin | undefined>, slide: RefObject<HTMLElement | null>): HTMLElement | null {
	return (origin.current === undefined ? null : ribbonFocusTarget(origin.current)) ?? slide.current
}

// The full-page show covers the deck and the preview around it: while it runs, all of that leaves the tab order and
// the accessibility tree. That is what comes before the show in the deck's root, and the siblings of every ancestor up
// to the dialog it opened in (a page without one keeps the rest of its body). What follows the show in the root (the
// presenter's same-window view) stays live. Elements already inert are left as they are.
function coverUnderShow(layer: HTMLElement | null): (() => void) | undefined {
	if (layer === null) return undefined

	const marked: Element[] = []
	const mark = (element: Element): void => {
		if (element.hasAttribute("inert")) return

		element.setAttribute("inert", "")
		marked.push(element)
	}

	for (let sibling = layer.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) mark(sibling)

	for (
		let node = layer.parentElement;
		node?.parentElement != null && node.parentElement !== document.body && node.getAttribute("role") !== "dialog";
		node = node.parentElement
	) {
		for (const sibling of node.parentElement.children) if (sibling !== node) mark(sibling)
	}

	return () => {
		for (const element of marked) element.removeAttribute("inert")
	}
}

// A key the deck takes: React's from the deck's root, or the page's for one pressed elsewhere in the editor's layer.
export interface DeckKeyEvent {
	readonly key: string
	readonly code: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
	readonly repeat: boolean
	preventDefault(): void
	stopPropagation(): void
}

export interface DeckPresentation {
	readonly actions: PresentationActionActivator
	readonly showing: boolean
	// From the slide in view.
	readonly startShow: () => void
	// From a slide, or as a custom show (the Slide Show tab); the show's first slide without one.
	readonly startShowFrom: (from?: ShowFrom) => void
	// With the presenter view (its popup, or this window when the popup is blocked).
	readonly startPresenter: (from: ShowFrom) => void
	// The note about a refused action, over the canvas or the show.
	readonly refusedNote: (over: "canvas" | "show") => ReactNode
	// The full-page show while it runs, the presenter's view and prompts, and the link gate's dialog.
	readonly layer: ReactNode
	// First on the deck's root keydown; true: the key was the show's and the page does nothing more with it. While the
	// show runs every key is (the show's layers take them; one that reaches the root goes no further); otherwise
	// F5 and Shift+F5 start it, from the first slide and from the slide in view, and never reload the page.
	readonly onKey: (event: DeckKeyEvent) => boolean
}

// The deck's links, jumps and slide show around the slide at `index`; `go` shows another slide (a negative index
// goes nowhere), `focusSlide` puts focus back on the slide when the show ends; `editable`: ink drawn in the show may
// be kept.
export function useDeckPresentation({
	store,
	deck,
	index,
	go,
	focusSlide,
	editable = false
}: {
	store: PresentationStore
	deck: PresentationDocument
	index: number
	go: (index: number) => void
	focusSlide: RefObject<HTMLElement | null>
	editable?: boolean
}): DeckPresentation {
	const { t } = useTranslation("preview")
	const linkGate = useTrustedLinkGate()
	// The gate as of the last render, for the full-screen listener.
	const gate = useRef(linkGate)

	useEffect(() => {
		gate.current = linkGate
	})
	// Where the running show started (`from` undefined: its first slide; undefined: none runs).
	const [showing, setShowing] = useState<{ readonly from: ShowFrom | undefined } | undefined>(undefined)
	const bindings = usePresentationShowBindings()
	const [fullscreenActive, setFullscreenActive] = useState(false)
	// Counts refused actions while their note is up (0: none shown).
	const [refusedAt, setRefusedAt] = useState(0)
	const enteredFullscreen = useRef(false)
	// The show menu is open, or when Escape last closed it.
	const showMenu = useRef<{ open: boolean; escapedAt: number }>({ open: false, escapedAt: -Infinity })
	const count = deck.slides.length

	// The slide shown before this one, for "last viewed" jumps.
	const [viewed, setViewed] = useState({ shown: index, last: 0 })

	if (viewed.shown !== index) {
		setViewed({ shown: index, last: viewed.shown })
	}

	const jump = (target: PresentationJump): void => {
		switch (target.kind) {
			case "internal":
				switch (target.jump) {
					case "next":
						go(index + 1)
						return
					case "previous":
						go(index - 1)
						return
					case "first":
						go(0)
						return
					case "last":
						go(count - 1)
						return
					case "lastViewed":
						go(viewed.last)
						return
					// Ending the show means nothing outside it.
					case "end":
						return
				}

				return
			case "slide":
				go(deck.slides.findIndex(slide => slide.ref === target.slide))
				return
			case "customShow": {
				const first = deck.info?.customShows.find(show => show.id === target.id)?.slides[0]

				if (first !== undefined) go(deck.slides.findIndex(slide => slide.ref === first))
			}
		}
	}

	// A refused action (a program, a macro, a local file) says so for a moment, in the viewer and in the show.
	useEffect(() => {
		if (refusedAt === 0) return

		const timer = setTimeout(() => {
			setRefusedAt(0)
		}, REFUSED_NOTE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [refusedAt])

	// The page's link policy; in the viewer and editor jumps move the slide in view, in the show the show moves.
	const policy: PresentationActionPolicy = {
		link: {
			allow: isSafeAbsoluteHref,
			open: href => {
				if (!linkGate.intercept(href)) window.open(href, "_blank", "noopener,noreferrer")
			}
		},
		refused: () => {
			setRefusedAt(at => at + 1)
		}
	}
	const actions = presentationActions({ ...policy, navigate: jump })

	// In the show it sits over the stage, which stacks itself at the top (presentation.css --fo-show-z).
	const refusedNote = (over: "canvas" | "show"): ReactNode =>
		refusedAt === 0 ? null : (
			<div
				role="status"
				className={`pointer-events-none absolute bottom-3 left-1/2 max-w-[90%] -translate-x-1/2 rounded-md bg-popover px-3 py-1.5 text-center text-xs text-popover-foreground shadow-md ${over === "show" ? "z-[2147483647]" : "z-10"}`}
			>
				{t("previewPptxRefusedAction")}
			</div>
		)

	// The whole page in full screen (inside a click's activation; menus and dialogs portal to the body); resolves
	// whether it is.
	const fullscreen = async (options?: FullscreenOptions): Promise<boolean> => {
		if (!fullscreenSupported() || document.fullscreenElement !== null) return document.fullscreenElement !== null

		enteredFullscreen.current = true

		try {
			await document.documentElement.requestFullscreen(options)

			return true
		} catch (error) {
			enteredFullscreen.current = false
			log.warn("presentation", "full screen refused", { error })

			return false
		}
	}

	// Ending the show closes the link confirmation it opened.
	const endShow = (): void => {
		setShowing(undefined)
		linkGate.cancel()

		if (enteredFullscreen.current && document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined)

		enteredFullscreen.current = false
	}

	// The ribbon command that started the show (none for a key). When the show ends focus goes back to it by the
	// ribbon's rule, else to the slide.
	const origin = useRef<RibbonOrigin | undefined>(undefined)

	const presenter = usePresenter({
		deck,
		editable,
		fullscreen,
		fullscreenActive,
		returnFocus: () => endFocus(origin, focusSlide)
	})

	const startShowFrom = (from?: ShowFrom): void => {
		origin.current = showOrigin()
		// A menu left open by the last show (it ended under it) says nothing about this one.
		showMenu.current = { open: false, escapedAt: -Infinity }
		setShowing({ from })
		void fullscreen()
	}

	const startPresenter = (from: ShowFrom): void => {
		// The popup spends the click's activation: the stage then offers Start slideshow, whose click goes full screen.
		origin.current = showOrigin()
		showMenu.current = { open: false, escapedAt: -Infinity }

		const where = presenter.openPresenter()

		setShowing({ from })

		if (where === "sameWindow") void fullscreen()
	}

	// Focus goes back once the show and the presenter view are gone and the slide is shown again (however
	// the show ended), unless the keep-ink prompt took it, which gives it back the same way. Without a ribbon command
	// it goes to the slide only from nowhere.
	const running = showing !== undefined || presenter.active
	const wasRunning = useRef(false)

	useEffect(() => {
		const ended = wasRunning.current && !running

		wasRunning.current = running

		if (!ended) return

		const settle = (): void => {
			const active = document.activeElement
			const from = origin.current
			const nowhere = active === null || active === document.body

			if (active?.closest('[role="alertdialog"]') != null) return

			if (from !== undefined && (nowhere || ribbonFocusTarget(from) !== null)) focusByRibbonRule(from, () => focusSlide.current)
			else if (nowhere) focusSlide.current?.focus({ preventScroll: true })
		}

		if (origin.current === undefined) {
			settle()

			return undefined
		}

		// A ribbon command started it: once full screen is left and the ribbon has fit the page again (two frames), as
		// it may have rendered its controls anew meanwhile.
		let frame = 0
		const later = (): void => {
			frame = requestAnimationFrame(() => {
				frame = requestAnimationFrame(settle)
			})
		}

		if (document.fullscreenElement === null) later()
		else document.addEventListener("fullscreenchange", later, { once: true })

		return () => {
			cancelAnimationFrame(frame)
			document.removeEventListener("fullscreenchange", later)
		}
	}, [running, focusSlide])

	// Escape in full screen is the browser's (Firefox and Safari never pass it on): leaving the full screen the show
	// entered ends the show too, unless a link confirmation or the show menu was open over it: that Escape closes the
	// confirmation or the menu and the show goes on (the next Escape is the stage's).
	useEffect(() => {
		const onChange = (): void => {
			setFullscreenActive(document.fullscreenElement !== null)

			if (document.fullscreenElement !== null) return

			if (!enteredFullscreen.current) return

			enteredFullscreen.current = false

			const menu = showMenu.current

			if (gate.current.pending) gate.current.cancel()
			else if (!menu.open && performance.now() - menu.escapedAt >= MENU_ESCAPE_MS) setShowing(undefined)
		}

		document.addEventListener("fullscreenchange", onChange)

		return () => {
			document.removeEventListener("fullscreenchange", onChange)
		}
	}, [])

	const onKey = (event: DeckKeyEvent): boolean => {
		if (showing !== undefined) {
			if (event.key !== "Tab") event.stopPropagation()

			return true
		}

		if (count === 0 || event.repeat) return false

		const command = showKeyCommand(event, bindings, isMacPlatform())

		if (command !== "start" && command !== "startCurrent") return false

		event.preventDefault()
		event.stopPropagation()
		startShowFrom(command === "start" ? undefined : { index })

		return true
	}

	return {
		actions,
		showing: showing !== undefined,
		onKey,
		startShow: () => {
			startShowFrom({ index })
		},
		startShowFrom,
		startPresenter,
		refusedNote,
		layer: (
			<>
				{showing === undefined ? null : (
					<div
						ref={coverUnderShow}
						data-preview-surface
						className="fixed inset-0 z-50 bg-black"
						onClickCapture={presenter.stageProps.onClickCapture}
					>
						<DeckSlideShow
							store={store}
							deck={deck}
							{...(showing.from === undefined ? {} : { from: showing.from })}
							policy={policy}
							onSlide={slide => {
								go(slide)
								store.setWindow(slide)
							}}
							onEnd={endShow}
							controllerRef={presenter.attach}
							overlay={presenter.stageOverlay}
							onKey={presenter.stageProps.onKey}
							onPointer={presenter.stageProps.onPointer}
							ink={presenter.ink}
							onMenu={state => {
								showMenu.current = {
									open: state === "open",
									escapedAt: state === "escaped" ? performance.now() : showMenu.current.escapedAt
								}
							}}
						/>
						{refusedNote("show")}
					</div>
				)}
				{presenter.layer}
				<SetUpShowHost
					store={store}
					deck={deck}
				/>
				{linkGate.dialog}
			</>
		)
	}
}
