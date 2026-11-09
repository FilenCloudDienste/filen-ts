import { gunzipSync } from "fflate"
import { decodeUtf8 } from "../../xml/utf8"
import { HYPHENATION_LANGUAGES, HYPHENATION_TAGS } from "./languages.generated"
import { HyphenationPatterns } from "./patterns"

// The bundled pattern sets (assets/hyphenation), loaded the first time text in their language is hyphenated and
// kept compiled for the realm's lifetime: a worker serving several documents loads each language once.

// The pattern files by their path under assets/hyphenation, as stored (gzip) or already inflated: web fetches them
// from its own origin.
export interface HyphenationAssets {
	read(file: string): Promise<Uint8Array>
}

const known = new Map<string, number>()

// The pattern set for a BCP 47 tag (w:lang, fo:language with fo:country), as 1 + its index; 0 when none is
// bundled. The full tag is tried, then the language with its region, then the language alone.
export function hyphenationLanguage(tag: string | undefined): number {
	if (tag === undefined || tag.length === 0) return 0

	let found = known.get(tag)

	if (found !== undefined) return found

	const parts = tag.toLowerCase().replaceAll("_", "-").split("-")
	const primary = parts[0] ?? ""
	const region = parts.slice(1).find(part => /^(?:[a-z]{2}|\d{3})$/.test(part))
	const candidates = [parts.join("-"), region === undefined ? primary : `${primary}-${region}`, primary]

	found = 0

	for (const candidate of candidates) {
		const index = Object.hasOwn(HYPHENATION_TAGS, candidate) ? HYPHENATION_TAGS[candidate] : undefined

		if (index !== undefined) {
			found = index + 1

			break
		}
	}

	known.set(tag, found)

	return found
}

const Load = { NONE: 0, LOADING: 1, READY: 2, FAILED: 3 } as const

type Load = (typeof Load)[keyof typeof Load]

export class HyphenationLibrary {
	private readonly assets: HyphenationAssets
	private readonly state = new Uint8Array(HYPHENATION_LANGUAGES.length)
	private readonly sets: (HyphenationPatterns | undefined)[] = []
	private readonly loads = new Set<Promise<void>>()

	constructor(assets: HyphenationAssets) {
		this.assets = assets
	}

	// A language's compiled patterns (see hyphenationLanguage), or null until loaded (and for one that failed to).
	patterns(language: number): HyphenationPatterns | null {
		return this.sets[language - 1] ?? null
	}

	// Starts loading a language unless it has been; true once its patterns are ready.
	request(language: number): boolean {
		const index = language - 1
		const state = (this.state[index] ?? Load.FAILED) as Load

		if (state === Load.READY) return true
		if (state !== Load.NONE) return false

		this.state[index] = Load.LOADING

		const entry = HYPHENATION_LANGUAGES[index]
		const load = (async () => {
			if (entry === undefined) throw new Error(`No hyphenation patterns ${language}`)

			const stored = await this.assets.read(entry.file)
			const bytes =
				stored.length >= 2 && stored[0] === 0x1f && stored[1] === 0x8b
					? gunzipSync(stored, { out: new Uint8Array(entry.size) })
					: stored
			const text = decodeUtf8(bytes)
			const newline = text.indexOf("\n")

			this.sets[index] = new HyphenationPatterns(
				newline < 0 ? text : text.slice(0, newline),
				newline < 0 ? "" : text.slice(newline + 1)
			)
			this.state[index] = Load.READY
		})().catch(() => {
			// Text in the language is laid out without automatic hyphenation.
			this.state[index] = Load.FAILED
		})

		this.loads.add(load)
		void load.then(() => this.loads.delete(load))

		return false
	}

	// Some language is still loading.
	get loading(): boolean {
		return this.loads.size > 0
	}

	// Settles once every load started so far has (loaded or failed).
	async whenLoaded(): Promise<void> {
		while (this.loads.size > 0) await Promise.all(this.loads)
	}
}
