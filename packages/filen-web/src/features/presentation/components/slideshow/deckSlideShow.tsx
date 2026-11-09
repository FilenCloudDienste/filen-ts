import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	paintSlide,
	presentationActions,
	SlideShow,
	type InkStore,
	type PresentationActionPolicy,
	type PresentationDocument,
	type PresentationStore,
	type ShowBarState,
	type ShowController,
	type ShowFrom,
	type ShowScreen
} from "@filen/office/react/presentation"
import { BrowseBar } from "@/features/presentation/components/slideshow/browseBar"
import { ShowMenu, type ShowMenuAt } from "@/features/presentation/components/slideshow/showMenu"
import { actionLabel, DEFAULT_SLIDE_SIZE } from "@/features/presentation/components/deckChrome.logic"
import { useShowMediaMount } from "@/features/presentation/hooks/useMediaInsert"
import { useChosenShowOptions } from "@/features/presentation/components/slideshow/showSettings"
import type { PreviewKey } from "@/lib/i18n"

// The deck's slide show as the viewer and the editor run it: the player over the deck's session and renders, with
// the deck's show settings (or what Set Up Slide Show chose), media playing in place, actions judged by the page's
// link policy inside the show, and a note for what the show could not play as the file says.

// How long a show note stays.
const NOTE_MS = 4000

const NOTES: Partial<Record<string, PreviewKey>> = {
	budget: "previewPptxShowTimingTooLarge",
	fontScale: "previewPptxShowFontScaled"
}

export interface DeckSlideShowProps {
	readonly store: PresentationStore
	readonly deck: PresentationDocument
	// The show's first slide without one.
	readonly from?: ShowFrom
	readonly policy: PresentationActionPolicy
	readonly onSlide: (index: number) => void
	readonly onEnd: () => void
	// The presenter's side (its controller, pen and laser over the slide, keys and swipes first). The controller's
	// cleanup runs when the stage goes away (full screen left), with or without an ended event.
	readonly controllerRef?: (controller: ShowController | null) => (() => void) | undefined
	readonly overlay?: ReactNode
	readonly onKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
	readonly onPointer?: (event: PointerEvent<HTMLDivElement>) => boolean
	// The presenter's ink, for the show menu's Pointer options.
	readonly ink?: InkStore
	// The show menu opened, closed, or was closed by Escape (which in full screen also leaves it).
	readonly onMenu?: (state: "open" | "closed" | "escaped") => void
	// Browsed by an individual: the show in the page's window with its status bar; `fullscreen` says whether the page
	// is in full screen (undefined: the browser has none), which Escape leaves before it ends the show. Read once.
	readonly browse?: { readonly fullscreen: boolean | undefined; readonly onFullscreen: () => void }
}

export function DeckSlideShow({
	store,
	deck,
	from,
	policy,
	onSlide,
	onEnd,
	controllerRef,
	overlay,
	onKey,
	onPointer,
	ink,
	onMenu,
	browse
}: DeckSlideShowProps) {
	const { t } = useTranslation("preview")
	const chosen = useChosenShowOptions(store)
	const media = useShowMediaMount(presentationActions(policy), store)
	const [note, setNote] = useState<{ readonly key: PreviewKey; readonly at: number } | undefined>(undefined)
	const [menu, setMenu] = useState<ShowMenuAt | undefined>(undefined)
	// The player's controller and the deck index on stage, read as the menu opens (no render per slide).
	const live = useRef<{ controller: ShowController | undefined; index: number | undefined }>({ controller: undefined, index: undefined })

	const closeMenu = (escaped: boolean): void => {
		setMenu(undefined)
		onMenu?.(escaped ? "escaped" : "closed")
	}

	// Leaving full screen (Escape, which Firefox and Safari keep from the page) closes the menu.
	useEffect(() => {
		if (menu === undefined) return

		const onChange = (): void => {
			if (document.fullscreenElement === null) {
				setMenu(undefined)
				onMenu?.("escaped")
			}
		}

		document.addEventListener("fullscreenchange", onChange)

		return () => {
			document.removeEventListener("fullscreenchange", onChange)
		}
	}, [menu, onMenu])

	useEffect(() => {
		if (note === undefined) return

		const timer = setTimeout(() => {
			setNote(undefined)
		}, NOTE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [note])

	// The show's notices (refused actions are the page's own note) as one note at a time.
	const attach = (controller: ShowController | null): (() => void) | undefined => {
		if (controller === null) return undefined

		const detach = controllerRef?.(controller)
		const off = controller.on("notice", event => {
			const key = NOTES[event.notice.kind]

			if (key !== undefined) setNote({ key, at: performance.now() })
		})

		live.current.controller = controller

		return () => {
			off()

			if (live.current.controller === controller) live.current.controller = undefined

			detach?.()
		}
	}

	return (
		<>
			<SlideShow
				slides={deck.slides}
				customShows={deck.info?.customShows ?? []}
				renders={deck.renders}
				size={deck.info?.size ?? DEFAULT_SLIDE_SIZE}
				painter={paintSlide}
				{...(deck.session === undefined ? {} : { session: deck.session })}
				{...(chosen === undefined ? (deck.info?.show === undefined ? {} : { settings: deck.info.show }) : { options: chosen })}
				{...(from === undefined ? {} : { from })}
				onSlide={index => {
					live.current.index = index
					onSlide(index)
				}}
				onEnd={onEnd}
				label={t("previewPptxShowLabel")}
				endLabel={t("previewPptxShowEnd")}
				slideLabel={(slide, total) => t("previewPptxSlideLabel", { current: slide + 1, total })}
				actionLabel={(action, layer) => actionLabel(t, action, layer)}
				triggerLabel={layer => {
					const name = layer.alt?.trim() ?? ""

					return name === "" ? t("previewPptxShowTriggerUnnamed") : t("previewPptxShowTrigger", { name })
				}}
				linkLabel={link =>
					t("previewPptxShowLink", { target: link.tooltip ?? (link.kind === "external" ? link.href : link.anchor) })
				}
				policy={policy}
				media={media}
				{...(overlay === undefined ? {} : { overlay })}
				{...(browse === undefined
					? onKey === undefined
						? {}
						: { onKey }
					: {
							// Escape in full screen goes back to the window; the next one ends the show.
							onKey: (event: KeyboardEvent<HTMLDivElement>) => {
								if (event.key === "Escape" && browse.fullscreen === true) {
									event.preventDefault()
									browse.onFullscreen()

									return true
								}

								return onKey?.(event) === true
							},
							statusBar: ({ index }: ShowBarState) => (
								<BrowseBar
									index={index}
									slides={deck.slides}
									controller={() => live.current.controller}
									fullscreen={browse.fullscreen}
									onFullscreen={browse.onFullscreen}
								/>
							)
						})}
				{...(onPointer === undefined ? {} : { onPointer })}
				onContextMenu={({ x, y, stage }) => {
					const index = live.current.index
					// The stage says which screen it shows.
					const shown = stage.dataset["foScreen"]
					const screen: ShowScreen = shown === "black" || shown === "white" || shown === "end" ? shown : "slide"

					setMenu({ x, y, stage, index, slide: index === undefined ? undefined : deck.slides[index]?.ref, screen })
					onMenu?.("open")
				}}
				ref={attach}
			/>
			<ShowMenu
				at={menu}
				slides={deck.slides}
				controller={() => live.current.controller}
				ink={ink}
				onClose={closeMenu}
			/>
			{note === undefined ? null : (
				<div
					key={note.at}
					role="status"
					className={`pointer-events-none fixed ${browse === undefined ? "bottom-3" : "bottom-10"} left-1/2 z-[2147483647] max-w-[90%] -translate-x-1/2 rounded-md bg-popover px-3 py-1.5 text-center text-xs text-popover-foreground shadow-md`}
				>
					{t(note.key)}
				</div>
			)}
		</>
	)
}
