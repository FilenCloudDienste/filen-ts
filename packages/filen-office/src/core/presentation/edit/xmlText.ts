import { classifyHref } from "../actions"

// Text and links the editor puts into the model, made what the deck can carry: the writer replaces anything XML 1.0
// cannot hold with U+FFFD (core/xml/entities.ts), which the proof then reads back as a different value and refuses
// the whole save. So every model text an edit sets passes through xmlSafeText first, and every link through
// presentationHref, which judges it with the save path's own classifier.

// Whether a UTF-16 code unit at `index` of `text` is one XML 1.0 cannot carry (C0 controls but tab and line ends,
// U+FFFE, U+FFFF, an unpaired surrogate). Returns the units it spans that are fine (2 for a pair), or 0.
function carriable(text: string, index: number): number {
	const code = text.charCodeAt(index)

	if (code < 0x20) return code === 9 || code === 10 || code === 13 ? 1 : 0
	if (code < 0xd800) return 1
	if (code <= 0xdbff) {
		const next = text.charCodeAt(index + 1)

		return next >= 0xdc00 && next <= 0xdfff ? 2 : 0
	}
	if (code <= 0xdfff) return 0

	return code === 0xfffe || code === 0xffff ? 0 : 1
}

// `text` with what XML 1.0 cannot carry taken out: U+000B (the soft line break PowerPoint and Word put on the
// clipboard) and U+000C become a space, every other C0 control but tab and line ends, unpaired surrogates and
// U+FFFE/U+FFFF are dropped. The same string when nothing changes. A caller that means U+000B as a line break
// splits on it before.
export function xmlSafeText(text: string): string {
	let out = ""
	let runStart = 0
	let index = 0

	while (index < text.length) {
		const span = carriable(text, index)

		if (span > 0) {
			index += span

			continue
		}

		const code = text.charCodeAt(index)

		out += text.slice(runStart, index) + (code === 0x0b || code === 0x0c ? " " : "")
		index++
		runStart = index
	}

	return runStart === 0 ? text : out + text.slice(runStart)
}

// Whether a code unit is one a link may not hold as it is (a space, a control character, DEL).
function unsafeInLink(code: number): boolean {
	return code <= 0x20 || code === 0x7f
}

// The link to store for what the user typed, or undefined when the deck may not carry it: trimmed, spaces and
// control characters after the host percent-encoded (as a browser's URL parser encodes them in a path, query or
// fragment), then accepted only as classifyHref (the reader's and the save proof's rule) accepts it: an absolute
// http, https or mailto URL. One with a space in its host stays refused.
export function presentationHref(input: string): string | undefined {
	const trimmed = input.trim()
	const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/u.exec(trimmed)?.[0].length ?? 0
	let href = ""
	let runStart = 0

	for (let index = 0; index < trimmed.length; index++) {
		const code = trimmed.charCodeAt(index)

		if (!unsafeInLink(code)) continue
		if (index < authority) return undefined

		href += `${trimmed.slice(runStart, index)}%${code.toString(16).toUpperCase().padStart(2, "0")}`
		runStart = index + 1
	}

	href = runStart === 0 ? trimmed : href + trimmed.slice(runStart)

	return classifyHref(href).kind === "url" ? href : undefined
}
