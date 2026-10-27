import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	paintSlide,
	presentationActions,
	SlideShow,
	type PresentationActionPolicy,
	type PresentationDocument,
	type PresentationStore,
	type ShowController,
	type ShowFrom
} from "@filen/office/react/presentation"
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
}

export function DeckSlideShow({ store, deck, from, policy, onSlide, onEnd, controllerRef, overlay, onKey, onPointer }: DeckSlideShowProps) {
	const { t } = useTranslation("preview")
	const chosen = useChosenShowOptions(store)
	const media = useShowMediaMount(presentationActions(policy), store)
	const [note, setNote] = useState<{ readonly key: PreviewKey; readonly at: number } | undefined>(undefined)

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

		return () => {
			off()
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
				onSlide={onSlide}
				onEnd={onEnd}
				label={t("previewPptxShowLabel")}
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
				{...(onKey === undefined ? {} : { onKey })}
				{...(onPointer === undefined ? {} : { onPointer })}
				ref={attach}
			/>
			{note === undefined ? null : (
				<div
					key={note.at}
					role="status"
					className="pointer-events-none fixed bottom-3 left-1/2 z-[2147483647] max-w-[90%] -translate-x-1/2 rounded-md bg-popover px-3 py-1.5 text-center text-xs text-popover-foreground shadow-md"
				>
					{t(note.key)}
				</div>
			)}
		</>
	)
}
