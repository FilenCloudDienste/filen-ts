import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import {
	paintSlide,
	presentationActions,
	StaticShow,
	type PresentationActionActivator,
	type PresentationDocument,
	type PresentationJump,
	type PresentationStore
} from "@filen/office/react/presentation"
import { actionLabel, DEFAULT_SLIDE_SIZE } from "@/features/presentation/components/deckChrome.logic"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { isSafeAbsoluteHref } from "@/lib/safeUrl"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { log } from "@/lib/log"

// The deck's links, jumps and static slide show, as the presentation viewer and editor share them: links on the
// slide are judged when clicked, a refused action says so for a moment, and the show runs over the whole page (in
// full screen where the browser allows it).

// How long the note about a refused action stays.
const REFUSED_NOTE_MS = 4000

export interface DeckPresentation {
	readonly actions: PresentationActionActivator
	readonly showing: boolean
	readonly startShow: () => void
	// The note about a refused action, over the canvas or the show.
	readonly refusedNote: (over: "canvas" | "show") => ReactNode
	// The full-page show while it runs, and the link gate's dialog.
	readonly layer: ReactNode
}

// The deck's links, jumps and slide show around the slide at `index`; `go` shows another slide (a negative index
// goes nowhere), `focusSlide` puts focus back on the slide when the show ends.
export function useDeckPresentation({
	store,
	deck,
	index,
	go,
	focusSlide
}: {
	store: PresentationStore
	deck: PresentationDocument
	index: number
	go: (index: number) => void
	focusSlide: RefObject<HTMLElement | null>
}): DeckPresentation {
	const { t } = useTranslation("preview")
	const linkGate = useTrustedLinkGate()
	const [showing, setShowing] = useState(false)
	// Counts refused actions while their note is up (0: none shown).
	const [refusedAt, setRefusedAt] = useState(0)
	const enteredFullscreen = useRef(false)
	const count = deck.slides.length
	const size = deck.info?.size ?? DEFAULT_SLIDE_SIZE

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

	const actions = presentationActions({
		link: {
			allow: isSafeAbsoluteHref,
			open: href => {
				if (!linkGate.intercept(href)) window.open(href, "_blank", "noopener,noreferrer")
			}
		},
		navigate: jump,
		refused: () => {
			setRefusedAt(at => at + 1)
		}
	})

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

	const startShow = (): void => {
		setShowing(true)

		// The whole page, inside the click's activation (menus and dialogs portal to the body).
		if (fullscreenSupported() && document.fullscreenElement === null) {
			enteredFullscreen.current = true
			document.documentElement.requestFullscreen().catch((error: unknown) => {
				enteredFullscreen.current = false
				log.warn("presentation", "full screen refused", { error })
			})
		}
	}

	const endShow = (): void => {
		setShowing(false)

		if (enteredFullscreen.current && document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined)

		enteredFullscreen.current = false
		focusSlide.current?.focus({ preventScroll: true })
	}

	// Escape in full screen is the browser's (Firefox and Safari never pass it on): leaving the full screen the show
	// entered ends the show too.
	useEffect(() => {
		if (!showing) return

		const onChange = (): void => {
			if (document.fullscreenElement === null && enteredFullscreen.current) {
				enteredFullscreen.current = false
				setShowing(false)
				focusSlide.current?.focus({ preventScroll: true })
			}
		}

		document.addEventListener("fullscreenchange", onChange)

		return () => {
			document.removeEventListener("fullscreenchange", onChange)
		}
	}, [showing, focusSlide])

	return {
		actions,
		showing,
		startShow,
		refusedNote,
		layer: (
			<>
				{showing ? (
					<div
						data-preview-surface
						className="fixed inset-0 z-50 bg-black"
					>
						<StaticShow
							slides={deck.slides}
							customShows={deck.info?.customShows ?? []}
							renders={deck.renders}
							size={size}
							painter={paintSlide}
							{...(deck.session === undefined ? {} : { session: deck.session })}
							from={{ index }}
							onSlide={slide => {
								go(slide)
								store.setWindow(slide)
							}}
							onEnd={endShow}
							label={t("previewPptxShowLabel")}
							slideLabel={(slide, total) => t("previewPptxSlideLabel", { current: slide + 1, total })}
							actionLabel={(action, layer) => actionLabel(t, action, layer)}
							actions={actions}
						/>
						{refusedNote("show")}
					</div>
				) : null}
				{linkGate.dialog}
			</>
		)
	}
}
