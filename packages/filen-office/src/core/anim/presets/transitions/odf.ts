import type { Fragment } from "../../../odp/read/context"
import type { Transition } from "../../model"

// A page's transition par in its ODF timing root (LibreOffice's form, core/odp/write/emit/transition.ts): an anim:par
// holding an untargeted anim:transitionFilter and, besides it, only the transition's sound (anim:audio, or
// anim:command "stop-audio"). It is the page transition, not an effect.
export function isPageTransitionPar(fragment: Fragment, node: number): boolean {
	const document = fragment.document

	if (fragment.name(node) !== "anim:par") return false

	let filter = false

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const name = fragment.name(child)
		const attributes = fragment.attributes(child)

		if (attributes.has("smil:targetElement")) return false
		if (name === "anim:transitionFilter" && !filter) filter = true
		else if (name !== "anim:audio" && !(name === "anim:command" && attributes.get("anim:command") === "stop-audio")) return false
	}

	return filter
}

// The transition par's sound as the model holds it: its anim:audio (a package path, looping when repeated without
// end), or "stop-audio"; undefined for none (and for a linked sound, which stays in the source).
export function pageTransitionSound(fragment: Fragment, par: number, part: (href: string) => string | undefined): Transition["sound"] {
	const document = fragment.document

	for (let child = document.firstChildElement(par); child >= 0; child = document.nextSiblingElement(child)) {
		const name = fragment.name(child)
		const attributes = fragment.attributes(child)

		if (name === "anim:command" && attributes.get("anim:command") === "stop-audio") return { kind: "stop" }
		if (name !== "anim:audio") continue

		const path = part(attributes.get("xlink:href") ?? "")

		return path === undefined ? undefined : { kind: "embedded", part: path, loop: attributes.get("smil:repeatCount") === "indefinite" }
	}

	return undefined
}
