import { useEffect } from "react"
import { appHelpAnchor } from "@filen/shared/assistant"
import { HELP_HIGHLIGHT_WAIT_MS, subscribeSettingsHighlight, takeSettingsHighlight } from "@/lib/settingsHighlight"
import { prefersReducedMotion } from "@/lib/motion"

// The attribute index.css pulses the ring on.
export const HELP_HIGHLIGHT_ATTRIBUTE = "data-help-highlight"

export const HELP_HIGHLIGHT_MS = 2000

// Scrolls the element with this id into view and pulses its ring for HELP_HIGHLIGHT_MS, waiting up to `waitMs` for it to
// render. A group is ringed on its panel, whose rounded edge the ring follows. Returns the cancel, which also ends a
// pulse in progress. The watch lasts only while the row is missing; a row that never renders (a desktop-only or
// conditional row) leaves nothing behind.
export function highlightWhenRendered(anchor: string, waitMs: number): () => void {
	let observer: MutationObserver | null = null
	let waitTimer: ReturnType<typeof setTimeout> | undefined = undefined
	let endTimer: ReturnType<typeof setTimeout> | undefined = undefined
	let ringed: Element | null = null

	function stopWaiting(): void {
		observer?.disconnect()
		observer = null
		clearTimeout(waitTimer)
	}

	function show(target: HTMLElement): void {
		// Scrolling flushes the style, so a ring removed by a cancel just before restarts its pulse.
		target.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" })
		ringed = target.dataset["slot"] === "settings-group" ? (target.querySelector('[data-slot="settings-panel"]') ?? target) : target
		ringed.setAttribute(HELP_HIGHLIGHT_ATTRIBUTE, "")

		const shown = ringed

		endTimer = setTimeout(() => {
			shown.removeAttribute(HELP_HIGHLIGHT_ATTRIBUTE)
		}, HELP_HIGHLIGHT_MS)
	}

	const present = document.getElementById(anchor)

	if (present !== null) {
		show(present)
	} else {
		observer = new MutationObserver(() => {
			const target = document.getElementById(anchor)

			if (target !== null) {
				stopWaiting()
				show(target)
			}
		})
		observer.observe(document.body, { childList: true, subtree: true })
		waitTimer = setTimeout(stopWaiting, waitMs)
	}

	return () => {
		stopWaiting()
		clearTimeout(endTimer)
		ringed?.removeAttribute(HELP_HIGHLIGHT_ATTRIBUTE)
	}
}

// Mounted by the settings layout: takes a request made before Settings opened and every one made while it is open.
export function useHelpHighlight(): void {
	useEffect(() => {
		let cancel: (() => void) | null = null

		function take(): void {
			const id = takeSettingsHighlight()

			if (id === null) {
				return
			}

			cancel?.()
			cancel = highlightWhenRendered(appHelpAnchor(id), HELP_HIGHLIGHT_WAIT_MS)
		}

		take()

		const unsubscribe = subscribeSettingsHighlight(take)

		return () => {
			unsubscribe()
			cancel?.()
		}
	}, [])
}
