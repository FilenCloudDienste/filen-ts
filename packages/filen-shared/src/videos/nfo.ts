export const MAX_NFO_CHARS = 256 * 1024

export type NfoKind = "movie" | "tvshow" | "episodedetails" | "season"

export interface NfoData {
	kind: NfoKind
	title?: string
	originalTitle?: string
	sortTitle?: string
	plot?: string
	tagline?: string
	year?: number
	// ISO-ish date string as written (`premiered`, else `aired`, else `releasedate`).
	premiered?: string
	runtimeMinutes?: number
	mpaa?: string
	genres: string[]
	tags: string[]
	studios: string[]
	// Actor names (`<actor><name>`), in file order.
	cast: string[]
	season?: number
	episode?: number
	episodeEnd?: number
	airsBeforeSeason?: number
	airsAfterSeason?: number
	lockData?: boolean
}

const ROOTS: ReadonlySet<string> = new Set(["movie", "tvshow", "episodedetails", "season"])

const FIELDS: ReadonlySet<string> = new Set([
	"title",
	"originaltitle",
	"sorttitle",
	"plot",
	"tagline",
	"year",
	"premiered",
	"aired",
	"releasedate",
	"runtime",
	"mpaa",
	"genre",
	"tag",
	"studio",
	"season",
	"seasonnumber",
	"episode",
	"episodenumberend",
	"airsbefore_season",
	"airsafter_season",
	"lockdata"
])

const MAX_DEPTH = 64
const MAX_FIELD_CHARS = 64 * 1024
const MAX_LIST = 64
const MAX_ITEM_CHARS = 256

// A Map, so an entity name never resolves an inherited object key.
const XML_ENTITIES: ReadonlyMap<string, string> = new Map([
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["quot", '"'],
	["apos", "'"]
])

// First index of the char `code` in [from, to), else -1.
function findBefore(text: string, code: number, from: number, to: number): number {
	for (let i = from; i < to; i++) {
		if (text.charCodeAt(i) === code) {
			return i
		}
	}

	return -1
}

// Entities are bounded (`&...;` within 10 chars); unknown ones stay literal. No DTD, so nothing can expand.
function decodeXmlText(value: string): string {
	let at = value.indexOf("&")

	if (at === -1) {
		return value
	}

	let out = ""
	let from = 0

	while (at !== -1) {
		out += value.slice(from, at)

		let end = -1

		for (let j = at + 1; j < Math.min(value.length, at + 11); j++) {
			if (value.charCodeAt(j) === 59) {
				end = j

				break
			}
		}

		let decoded: string | undefined

		if (end !== -1) {
			const name = value.slice(at + 1, end)

			decoded = XML_ENTITIES.get(name)

			if (decoded === undefined && name.charCodeAt(0) === 35) {
				const hex = name.charCodeAt(1) === 120
				const digits = name.slice(hex ? 2 : 1)
				const code = /^[0-9a-fA-F]{1,6}$/.test(digits) && (hex || /^[0-9]+$/.test(digits)) ? parseInt(digits, hex ? 16 : 10) : NaN

				if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
					decoded = String.fromCodePoint(code)
				}
			}
		}

		if (decoded === undefined) {
			out += "&"
			from = at + 1
		} else {
			out += decoded
			from = end + 1
		}

		at = value.indexOf("&", from)
	}

	return out + value.slice(from)
}

function toInt(value: string): number | undefined {
	if (!/^-?\d{1,6}$/.test(value)) {
		return undefined
	}

	return Number(value)
}

function toMinutes(value: string): number | undefined {
	const match = /^(\d{1,5})(?:[.,]\d+)?(?:\s*(?:min|minutes?|m))?$/i.exec(value)

	return match === null ? undefined : Number(match[1])
}

function pushUnique(list: string[], value: string): void {
	if (value.length > 0 && list.length < MAX_LIST && !list.includes(value)) {
		list.push(value.length > MAX_ITEM_CHARS ? value.slice(0, MAX_ITEM_CHARS) : value)
	}
}

// End of the last closing root tag, so trailing junk (appended URLs, another document) is ignored.
function endOfLastRoot(text: string): number {
	let best = -1

	for (const root of ROOTS) {
		const at = text.lastIndexOf(`</${root}`)

		if (at !== -1) {
			const gt = text.indexOf(">", at)
			const end = gt === -1 ? text.length : gt + 1

			if (end > best) {
				best = end
			}
		}
	}

	return best === -1 ? text.length : best
}

// Worker-safe tokenizer for Kodi/Jellyfin `.nfo` files (no DOMParser). Only direct children of the root, and actors'
// names, are read; for repeated scalar tags the last one wins. Several `<episodedetails>` roots widen `episodeEnd`.
// null when there is no known root.
export function parseNfo(input: string): NfoData | null {
	const source = input.length > MAX_NFO_CHARS ? input.slice(0, MAX_NFO_CHARS) : input
	const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
	const limit = endOfLastRoot(text)
	const stack: string[] = []
	const data: NfoData = {
		kind: "movie",
		genres: [],
		tags: [],
		studios: [],
		cast: []
	}
	const dates: { premiered?: string; aired?: string; releasedate?: string } = {}
	let rootCount = 0
	let rootActive = false
	let secondaryRoot = false
	let captureName: string | null = null
	// Stack depth the captured element sits at: 1 for a field, 2 for an actor's name.
	let captureDepth = 1
	let captureText = ""
	let gt = -1
	let i = 0

	const append = (chunk: string) => {
		if (captureName !== null && captureText.length < MAX_FIELD_CHARS) {
			captureText += chunk.length > MAX_FIELD_CHARS ? chunk.slice(0, MAX_FIELD_CHARS) : chunk
		}
	}

	const finish = () => {
		const name = captureName
		const value = captureText.trim()

		captureName = null
		captureText = ""

		if (name === null || value.length === 0) {
			return
		}

		if (secondaryRoot) {
			const episode = toInt(value)

			if (name === "episode" && episode !== undefined && episode >= 0 && episode > (data.episodeEnd ?? data.episode ?? -1)) {
				data.episodeEnd = episode
			}

			return
		}

		switch (name) {
			case "title":
				data.title = value

				break
			case "originaltitle":
				data.originalTitle = value

				break
			case "sorttitle":
				data.sortTitle = value

				break
			case "plot":
				data.plot = value

				break
			case "tagline":
				data.tagline = value

				break
			case "year": {
				const year = toInt(value)

				if (year !== undefined && year >= 1800 && year <= 2200) {
					data.year = year
				}

				break
			}
			case "premiered":
			case "aired":
			case "releasedate":
				dates[name] = value.length > 64 ? value.slice(0, 64) : value

				break
			case "runtime": {
				const minutes = toMinutes(value)

				if (minutes !== undefined && minutes > 0) {
					data.runtimeMinutes = minutes
				}

				break
			}
			case "mpaa":
				data.mpaa = value

				break
			case "genre":
				pushUnique(data.genres, value)

				break
			case "tag":
				pushUnique(data.tags, value)

				break
			case "studio":
				pushUnique(data.studios, value)

				break
			case "actor":
				pushUnique(data.cast, value)

				break
			case "season":
			case "seasonnumber": {
				const n = toInt(value)

				if (n !== undefined && n >= 0) {
					data.season = n
				}

				break
			}
			case "episode": {
				const n = toInt(value)

				if (n !== undefined && n >= 0) {
					data.episode = n
				}

				break
			}
			case "episodenumberend": {
				const n = toInt(value)

				if (n !== undefined && n >= 0) {
					data.episodeEnd = n
				}

				break
			}
			case "airsbefore_season": {
				const n = toInt(value)

				if (n !== undefined && n >= 0) {
					data.airsBeforeSeason = n
				}

				break
			}
			case "airsafter_season": {
				const n = toInt(value)

				if (n !== undefined && n >= 0) {
					data.airsAfterSeason = n
				}

				break
			}
			case "lockdata":
				data.lockData = value.toLowerCase() === "true"

				break
		}
	}

	while (i < limit) {
		const lt = text.indexOf("<", i)

		if (lt === -1 || lt >= limit) {
			append(decodeXmlText(text.slice(i, limit)))

			break
		}

		if (lt > i) {
			append(decodeXmlText(text.slice(i, lt)))
		}

		if (text.startsWith("<!--", lt)) {
			const end = text.indexOf("-->", lt + 4)

			i = end === -1 ? limit : end + 3

			continue
		}

		if (text.startsWith("<![CDATA[", lt)) {
			const end = text.indexOf("]]>", lt + 9)

			append(text.slice(lt + 9, end === -1 ? limit : end))
			i = end === -1 ? limit : end + 3

			continue
		}

		if (text.startsWith("<?", lt)) {
			const end = text.indexOf("?>", lt + 2)

			i = end === -1 ? limit : end + 2

			continue
		}

		if (text.startsWith("<!", lt)) {
			// DOCTYPE, possibly with an internal subset in brackets; skipped, never interpreted. A subset opens before
			// the first `>`, so the bracket is looked for only up to it and runs of `<!x>` stay linear.
			const gt = text.indexOf(">", lt)
			const bracket = findBefore(text, 91, lt + 2, gt === -1 ? limit : gt)
			const end = bracket === -1 ? gt : text.indexOf("]>", bracket)

			i = end === -1 ? limit : end + (bracket === -1 ? 1 : 2)

			continue
		}

		// A `<` that cannot start a name is plain text.
		const after = text.charCodeAt(lt + 1)

		if (!((after >= 65 && after <= 90) || (after >= 97 && after <= 122) || after === 95 || after === 58 || after === 47)) {
			append("<")
			i = lt + 1

			continue
		}

		if (gt < lt) {
			gt = text.indexOf(">", lt + 1)

			if (gt === -1) {
				break
			}
		}

		// Tags are short; a far `>` means this `<` is text.
		if (gt - lt > 4096) {
			i = lt + 1

			continue
		}

		const end = gt + 1

		const closing = text.charCodeAt(lt + 1) === 47
		const selfClosing = text.charCodeAt(end - 2) === 47
		const nameStart = lt + (closing ? 2 : 1)
		let nameEnd = nameStart

		while (nameEnd < end - 1) {
			const c = text.charCodeAt(nameEnd)

			if (c <= 32 || c === 47) {
				break
			}

			nameEnd++
		}

		const name = text.slice(nameStart, nameEnd).toLowerCase()

		i = end

		if (name.length === 0) {
			continue
		}

		if (closing) {
			const at = stack.lastIndexOf(name)

			if (at !== -1) {
				const wasCapturing = captureName !== null && at <= captureDepth

				stack.length = at

				if (wasCapturing) {
					finish()
				}
			}

			continue
		}

		if (stack.length >= MAX_DEPTH) {
			break
		}

		if (stack.length === 0) {
			rootActive = false
			secondaryRoot = false

			if (ROOTS.has(name)) {
				rootCount++

				if (rootCount === 1) {
					data.kind = name as NfoKind
					rootActive = true
				} else if (name === "episodedetails" && data.kind === "episodedetails") {
					rootActive = true
					secondaryRoot = true
				}
			}
		} else if (stack.length === 1 && rootActive && FIELDS.has(name) && captureName === null) {
			captureName = name
			captureDepth = 1
			captureText = ""
		} else if (stack.length === 2 && rootActive && !secondaryRoot && name === "name" && stack[1] === "actor" && captureName === null) {
			captureName = "actor"
			captureDepth = 2
			captureText = ""
		}

		if (selfClosing) {
			if ((captureName === name || (captureDepth === 2 && name === "name")) && stack.length === captureDepth) {
				captureName = null
				captureText = ""
			}

			continue
		}

		stack.push(name)
	}

	if (captureName !== null) {
		finish()
	}

	if (rootCount === 0) {
		return null
	}

	const premiered = dates.premiered ?? dates.aired ?? dates.releasedate

	if (premiered !== undefined) {
		data.premiered = premiered
	}

	return data
}
