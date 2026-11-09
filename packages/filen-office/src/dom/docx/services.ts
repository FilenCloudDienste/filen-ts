import type { FontAssets } from "../../core/fonts/index"
import { HyphenationLibrary, type TextMeasurer } from "../../core/text/index"
import { canMeasureOffscreen, canvasMeasurer, offscreenMeasurer, type CanvasContextLike } from "../canvasMeasurer"
import { fontFaceHost, type FontFaceScope } from "../fontFaceHost"
import { openOdtAsDocx } from "../../core/odt/index"
import type { DocxEngineServices } from "./engine"
import { macrotaskYield } from "./host"

type Fetch = (url: string) => Promise<{ readonly ok: boolean; readonly status: number; arrayBuffer(): Promise<ArrayBuffer> }>

// Where the app serves the bundled fonts: a base URL (path appended), or each file's URL (content-hashed
// names). Same origin either way: the apps' font-src is 'self'.
export type FontLocation = string | Readonly<Record<string, string>>

// Fetched files by URL, shared by every later document in a worker that outlives one document; a failed fetch
// is forgotten.
const shared = new Map<string, Promise<Uint8Array>>()

function fontUrl(location: FontLocation, file: string): string | undefined {
	if (typeof location !== "string") return Object.hasOwn(location, file) ? location[file] : undefined

	const base = location.endsWith("/") ? location : `${location}/`

	return base + file.split("/").map(encodeURIComponent).join("/")
}

// The bundled fonts, fetched on demand. Files are the manifest's paths under assets/fonts. `shared` keeps them
// for every later document in this realm (a worker); otherwise only as long as these assets are held (a page,
// which outlives every document).
export function fetchFontAssets(location: FontLocation, options: { readonly shared?: boolean } = {}): FontAssets {
	const fetched = options.shared === true ? shared : new Map<string, Promise<Uint8Array>>()

	return {
		async read(file) {
			const url = fontUrl(location, file)

			if (url === undefined) throw new Error(`Font ${file} is not served`)

			let load = fetched.get(url)

			if (load === undefined) {
				const fetcher: unknown = Reflect.get(globalThis, "fetch")

				if (typeof fetcher !== "function") throw new Error("fetch is not available")

				load = (async () => {
					const response = await (fetcher as Fetch)(url)

					if (!response.ok) throw new Error(`Font ${file}: HTTP ${response.status}`)

					return new Uint8Array(await response.arrayBuffer())
				})()
				fetched.set(url, load)
				load.catch(() => {
					if (fetched.get(url) === load) fetched.delete(url)
				})
			}

			// A copy: the platform may take the buffer it is given, and the cache keeps its own.
			return (await load).slice()
		}
	}
}

// Libraries by where their patterns are served, for the realm's lifetime: each language is fetched and compiled
// once, whatever the number of documents.
const libraries = new Map<FontLocation, HyphenationLibrary>()

// The bundled hyphenation patterns (paths under assets/hyphenation), fetched on first use from where the app serves
// them (same origin, like the fonts), as stored: the library inflates them.
export function hyphenationLibrary(location: FontLocation): HyphenationLibrary {
	let library = libraries.get(location)

	if (library === undefined) {
		library = new HyphenationLibrary({
			async read(file) {
				const url = fontUrl(location, file)
				const fetcher: unknown = Reflect.get(globalThis, "fetch")

				if (url === undefined) throw new Error(`Hyphenation patterns ${file} are not served`)
				if (typeof fetcher !== "function") throw new Error("fetch is not available")

				const response = await (fetcher as Fetch)(url)

				if (!response.ok) throw new Error(`Hyphenation patterns ${file}: HTTP ${response.status}`)

				return new Uint8Array(await response.arrayBuffer())
			}
		})
		libraries.set(location, library)
	}

	return library
}

function isFontFaceScope(scope: unknown): scope is FontFaceScope {
	return (
		typeof scope === "object" &&
		scope !== null &&
		typeof Reflect.get(scope, "FontFace") === "function" &&
		typeof Reflect.get(scope, "fonts") === "object"
	)
}

// Services for an engine in a worker: faces registered in the worker's own FontFaceSet (and replayed to
// the page), widths measured on an OffscreenCanvas. OpenDocument text is translated here, so the translator
// is in the worker's bundle only. `hyphenation`: where the hyphenation patterns are served (none: no automatic
// hyphenation).
export function workerServices(scope: unknown, fonts: FontLocation, hyphenation?: FontLocation): DocxEngineServices {
	if (!isFontFaceScope(scope)) throw new Error("The CSS Font Loading API is not available in this worker")

	return {
		fontHost: fontFaceHost(scope),
		replayFonts: true,
		fontAssets: fetchFontAssets(fonts, { shared: true }),
		...(hyphenation === undefined ? {} : { hyphenation: hyphenationLibrary(hyphenation) }),
		measurer: offscreenMeasurer(scope),
		yield: macrotaskYield(),
		sliceMs: 12,
		openOdt: openOdtAsDocx
	}
}

// A <canvas> 2D context of the window, for realms without OffscreenCanvas.
function elementMeasurer(scope: unknown): TextMeasurer {
	const document: unknown = typeof scope === "object" && scope !== null ? Reflect.get(scope, "document") : undefined
	const create: unknown = typeof document === "object" && document !== null ? Reflect.get(document, "createElement") : undefined

	if (typeof create !== "function") throw new Error("No canvas to measure text with")

	const canvas: unknown = Reflect.apply(create, document, ["canvas"])
	const getContext: unknown = typeof canvas === "object" && canvas !== null ? Reflect.get(canvas, "getContext") : undefined
	const context: unknown = typeof getContext === "function" ? Reflect.apply(getContext, canvas, ["2d"]) : undefined

	if (typeof context !== "object" || context === null || typeof Reflect.get(context, "measureText") !== "function") {
		throw new Error("No 2D canvas context to measure text with")
	}

	return canvasMeasurer(context as CanvasContextLike)
}

// Services for an engine on the page's own thread (an Expo DOM component, where workers are not
// assumed): faces go straight into the page's FontFaceSet, so nothing is replayed; layout yields often to
// keep input responsive. `assets` reads the bundled fonts (on mobile from the app bundle, as bytes); `hyphenation`
// holds the hyphenation patterns (none: no automatic hyphenation).
export function windowServices(scope: unknown, assets: FontAssets, hyphenation?: HyphenationLibrary): DocxEngineServices {
	const document: unknown = typeof scope === "object" && scope !== null ? Reflect.get(scope, "document") : undefined
	const fonts: unknown = typeof document === "object" && document !== null ? Reflect.get(document, "fonts") : undefined
	const FontFace: unknown = typeof scope === "object" && scope !== null ? Reflect.get(scope, "FontFace") : undefined
	const fontScope: unknown = { FontFace, fonts }

	if (!isFontFaceScope(fontScope)) throw new Error("The CSS Font Loading API is not available")

	return {
		fontHost: fontFaceHost(fontScope),
		replayFonts: false,
		fontAssets: assets,
		...(hyphenation === undefined ? {} : { hyphenation }),
		measurer: canMeasureOffscreen(scope) ? offscreenMeasurer(scope) : elementMeasurer(scope),
		yield: macrotaskYield(),
		sliceMs: 6
	}
}
