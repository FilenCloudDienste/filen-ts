// The part names a writer refusal's detail mentions ("/ppt/slides/slide2.xml reads back … differently", an ODP page
// "/content.xml#12"): what /[\w.-]+(?:\/[\w.-]+)*\.(?:xml|rels)(?:#[\w.-]+|\b)/g matches, as model part names;
// undefined when it names none. Found in time linear in the detail: from where a name may start, the stretch it may
// span (runs of [\w.-] joined by single slashes) is read once from its end for the last ".xml" or ".rels" a name
// ends with, as the expression's backtracking would settle on; a stretch with none is passed whole.
export function partsNamed(detail: string): ReadonlySet<string> | undefined {
	const names: string[] = []
	const n = detail.length
	let at = 0

	while (at < n) {
		if (!isNameCharacter(detail, at)) {
			at++
			continue
		}

		const start = at
		let stretch = start

		for (;;) {
			while (stretch < n && isNameCharacter(detail, stretch)) stretch++

			if (detail[stretch] === "/" && isNameCharacter(detail, stretch + 1)) {
				stretch++
				continue
			}

			break
		}

		const end = lastNameEnd(detail, start, stretch)

		if (end === undefined) {
			at = stretch
			continue
		}

		names.push(detail.slice(start, end))
		at = end
	}

	return names.length === 0 ? undefined : new Set(names.map(name => (name.startsWith("/") ? name : `/${name}`)))
}

// Where the longest name from `start` within the stretch ends: its last ".xml" or ".rels" after a name character,
// then "#" and an anchor, or a word boundary.
function lastNameEnd(detail: string, start: number, stretch: number): number | undefined {
	for (let point = stretch - 1; point > start; point--) {
		if (!isNameCharacter(detail, point - 1)) continue

		const after = detail.startsWith(".xml", point) ? point + 4 : detail.startsWith(".rels", point) ? point + 5 : -1

		if (after < 0) continue

		if (detail[after] === "#" && isNameCharacter(detail, after + 1)) {
			let anchor = after + 1

			while (anchor < detail.length && isNameCharacter(detail, anchor)) anchor++

			return anchor
		}

		if (!isWordCharacter(detail, after)) return after
	}

	return undefined
}

function isWordCharacter(text: string, at: number): boolean {
	const code = text.charCodeAt(at)

	return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f
}

// [\w.-]
function isNameCharacter(text: string, at: number): boolean {
	const code = text.charCodeAt(at)

	return isWordCharacter(text, at) || code === 0x2e || code === 0x2d
}
