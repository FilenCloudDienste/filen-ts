import type { Action, ShapeRef, SlideRef } from "../../core/presentation/model"
import type { DocxLinkTarget } from "../../dom/docx/protocol"
import type { PresentationNotice } from "../../dom/presentation/protocol"
import { linkActivator, type DocxLinkPolicy } from "../docx/links"

// What a click on a shape's action or a text link does. Judged when it happens, never when the slide is painted:
// http, https and mailto open (after the host is shown, unless the URL is the drive's own) on a click in the viewer
// or the show and on Mod+click in the editor; jumps navigate; everything the reader refused stays inert and is
// reported as a typed notice; hover actions never do anything.

export type PresentationJump =
	| { readonly kind: "internal"; readonly jump: "next" | "previous" | "first" | "last" | "end" | "lastViewed" }
	| { readonly kind: "slide"; readonly slide: SlideRef }
	| { readonly kind: "customShow"; readonly id: number; readonly returnAfter: boolean }

export interface PresentationActionPolicy {
	// The external link policy; its allow is judged after the URL scheme check, never instead of it.
	readonly link: DocxLinkPolicy
	// Drive URLs open without the host step.
	readonly isDrive?: (href: string) => boolean
	// Shows the host before a URL opens; `open` runs the policy's open. Absent: opens directly.
	readonly confirm?: (host: string, href: string, open: () => void) => void
	readonly navigate?: (jump: PresentationJump) => void
	readonly refused?: (notice: Extract<PresentationNotice, { kind: "refusedAction" }>) => void
	// Internal text-run links (an anchor in the deck).
	readonly anchor?: (anchor: string) => void
	// Plays the shape's own media (ppaction://media); absent: the action is inert.
	readonly media?: (request: PresentationMediaRequest) => void
}

export interface PresentationMediaRequest {
	readonly kind: "media"
	readonly shape: ShapeRef
}

export interface ActionTrigger {
	readonly via: "click" | "hover"
	readonly mode: "view" | "show" | "edit"
	// Mod (Ctrl, or Cmd on Apple platforms) held: the editor follows actions only then.
	readonly modifier: boolean
	readonly shape: ShapeRef
}

export type ActionOutcome = "opened" | "confirming" | "navigated" | "media" | "refused" | "inert" | "ignored"

export interface PresentationActionActivator {
	action(action: Action, trigger: ActionTrigger): ActionOutcome
	link(link: DocxLinkTarget, trigger: ActionTrigger): ActionOutcome
}

export const PRESENTATION_URL_SCHEMES: readonly string[] = ["http:", "https:", "mailto:"]

// Whether `href` is an absolute http, https or mailto URL. The reader classified it already; this is the same rule
// again at the moment of the click.
export function isPresentationUrl(href: string): boolean {
	const trimmed = href.trim()

	if (!URL.canParse(trimmed)) return false

	const url = new URL(trimmed)

	return PRESENTATION_URL_SCHEMES.includes(url.protocol) && (url.protocol === "mailto:" || url.hostname !== "")
}

function hostOf(href: string): string {
	const url = new URL(href.trim())

	return url.protocol === "mailto:" ? url.pathname : url.host
}

export function presentationActions(policy: PresentationActionPolicy): PresentationActionActivator {
	const open = linkActivator({
		allow: href => isPresentationUrl(href) && policy.link.allow(href),
		open: href => policy.link.open(href),
		...(policy.link.refused === undefined ? {} : { refused: policy.link.refused })
	})

	// Neither hover nor a plain click in the editor follows anything.
	const follows = (trigger: ActionTrigger): boolean => trigger.via === "click" && (trigger.mode !== "edit" || trigger.modifier)

	const url = (href: string, tooltip: string | undefined, trigger: ActionTrigger): ActionOutcome => {
		const link = { kind: "external", href, tooltip } as const

		if (!isPresentationUrl(href) || !policy.link.allow(href.trim())) {
			policy.link.refused?.(href.trim())
			policy.refused?.({ kind: "refusedAction", shape: trigger.shape, what: "scheme" })

			return "refused"
		}

		if (policy.confirm === undefined || policy.isDrive?.(href.trim()) === true) {
			open(link)

			return "opened"
		}

		policy.confirm(hostOf(href), href.trim(), () => open(link))

		return "confirming"
	}

	return {
		action(action, trigger) {
			if (!follows(trigger)) return trigger.via === "hover" ? "inert" : "ignored"

			switch (action.kind) {
				case "url":
					return url(action.href, undefined, trigger)
				case "internal":
					policy.navigate?.({ kind: "internal", jump: action.jump })

					return "navigated"
				case "slide":
					policy.navigate?.({ kind: "slide", slide: action.slide })

					return "navigated"
				case "customShow":
					policy.navigate?.({ kind: "customShow", id: action.id, returnAfter: action.returnAfter })

					return "navigated"
				case "media":
					if (policy.media === undefined) return "inert"

					policy.media({ kind: "media", shape: trigger.shape })

					return "media"
				case "refused":
					policy.refused?.({ kind: "refusedAction", shape: trigger.shape, what: action.what })

					return "refused"
			}
		},
		link(link, trigger) {
			if (!follows(trigger)) return trigger.via === "hover" ? "inert" : "ignored"

			if (link.kind === "external") return url(link.href, link.tooltip, trigger)

			policy.anchor?.(link.anchor)

			return "navigated"
		}
	}
}
