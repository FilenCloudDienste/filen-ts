import { decodeUtf8, encodeUtf8, escapeAttribute } from "../../xml/index"

// META-INF/manifest.xml with `entries` added as manifest:file-entry elements (ODF 1.3 Part 2 §4.3) before the root's end tag,
// in the prefix the root uses; undefined when the root's end cannot be found.
export function withManifestEntries(
	bytes: Uint8Array,
	entries: readonly { readonly path: string; readonly mediaType: string }[]
): Uint8Array | undefined {
	const text = decodeUtf8(bytes, 0, bytes.length)
	const close = /<\/([\w.-]+:)?manifest>\s*$/u.exec(text)

	if (close === null) return undefined

	const prefix = close[1] ?? ""
	const lines = encodeUtf8(
		entries
			.map(
				entry =>
					` <${prefix}file-entry ${prefix}full-path="${escapeAttribute(entry.path)}" ${prefix}media-type="${escapeAttribute(entry.mediaType)}"/>\n`
			)
			.join("")
	)
	const at = encodeUtf8(text.slice(0, close.index)).length
	const out = new Uint8Array(bytes.length + lines.length)

	out.set(bytes.subarray(0, at))
	out.set(lines, at)
	out.set(bytes.subarray(at), at + lines.length)

	return out
}

// META-INF/manifest.xml without the manifest:file-entry elements of `names` (ODF 1.3 Part 2 §4.3), every other byte
// as it was: entries a save leaves out leave the manifest with them. An entry goes with its indent and, when its line
// ends there, its line end (what withManifestEntries wrote for it); the spaces after an entry its line goes on from
// are the next one's indent.
//
// The entries are what /[ \t]*<([\w.-]+:)?file-entry\b[^>]*?(?:\/>|>[\s\S]*?<\/\1?file-entry>)(?:[ \t]*\r?\n)?/g
// matches, found in time linear in the manifest: from each start tag, its first ">" (self-closing after "/") or the
// first end tag after it, each end tag looked for once (none found: no later start tag finds one either); the indent
// before it back to where the previous entry ended.
export function withoutManifestEntries(manifest: Uint8Array, names: readonly string[]): Uint8Array {
	if (names.length === 0) return manifest

	const gone = new Set(names)
	const text = decodeUtf8(manifest, 0, manifest.length)
	const closes = new Map<string, number>()
	const closeAfter = (tag: string, from: number): number => {
		const held = closes.get(tag)

		if (held !== undefined && (held < 0 || held >= from)) return held

		const found = text.indexOf(tag, from)

		closes.set(tag, found)

		return found
	}
	const opening = /<([\w.-]+:)?file-entry(?!\w)/gu
	let out = ""
	let copied = 0
	let previous = 0
	let changed = false

	for (let match = opening.exec(text); match !== null; match = opening.exec(text)) {
		const tag = match.index
		const named = tag + match[0].length
		const gt = text.indexOf(">", named)

		if (gt < 0) break

		let end: number

		if (gt > named && text[gt - 1] === "/") end = gt + 1
		else {
			const prefixed = match[1] === undefined ? -1 : closeAfter(`</${match[1]}file-entry>`, gt + 1)
			const plain = closeAfter("</file-entry>", gt + 1)
			const close = prefixed < 0 ? plain : plain < 0 ? prefixed : Math.min(prefixed, plain)

			if (close < 0) continue

			end = close + (close === prefixed ? `</${match[1] ?? ""}file-entry>`.length : "</file-entry>".length)
		}

		let start = tag

		while (start > previous && (text[start - 1] === " " || text[start - 1] === "\t")) start--

		let line = end

		while (text[line] === " " || text[line] === "\t") line++

		if (text[line] === "\r") line++
		if (text[line] === "\n") end = line + 1

		previous = end
		opening.lastIndex = end

		const path = /\bfull-path\s*=\s*"([^"]*)"/u.exec(text.slice(start, end))?.[1]

		if (path === undefined || !gone.has(path)) continue

		out += text.slice(copied, start)
		copied = end
		changed = true
	}

	return changed ? encodeUtf8(out + text.slice(copied)) : manifest
}
