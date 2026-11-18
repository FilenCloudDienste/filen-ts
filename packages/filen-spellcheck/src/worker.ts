import { SpellEngine, type SpellDictionary } from "./engine"
import type { SpellcheckAsset, SpellcheckDictionaryAssets, SpellcheckRequest, SpellcheckResponse, SpellcheckWorkerScope } from "./protocol"

// The worker side: one wasm engine and the dictionaries the host asked for. Dictionary files are fetched
// from the app's origin (gzip), streamed through a DecompressionStream into one buffer each, verified
// against the manifest's SHA-256 when they came from the network, and kept in Cache Storage (compressed)
// for the next session. Requests for a dictionary wait for its load, so a host may send them right after
// the load request.

export const SPELLCHECK_CACHE = "filen-spellcheck-v1"

export interface SpellcheckWorkerOptions {
	readonly fetch?: (url: string) => Promise<Response>
	// Where downloaded dictionaries are kept; undefined disables caching.
	readonly caches?: CacheStorage | undefined
	// Resolves relative URLs when comparing cache entries (the worker's location by default).
	readonly base?: string
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function hex(digest: ArrayBuffer): string {
	let out = ""

	for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0")

	return out
}

// The bytes of a body that is gzip-compressed (as the app serves dictionaries) or not (a host that
// decoded it already): the gzip magic number decides.
async function inflated(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	const source = body.getReader()
	const first = await source.read()
	const gzip = first.value !== undefined && first.value.byteLength >= 2 && first.value[0] === 0x1f && first.value[1] === 0x8b
	const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			if (first.done) controller.close()
			else controller.enqueue(first.value)
		},
		async pull(controller) {
			const next = await source.read()

			if (next.done) controller.close()
			else controller.enqueue(next.value)
		},
		cancel(reason) {
			return source.cancel(reason)
		}
	})

	return (gzip ? stream.pipeThrough(new DecompressionStream("gzip")) : stream).getReader()
}

export function serveSpellcheckWorker(scope: SpellcheckWorkerScope, options: SpellcheckWorkerOptions = {}): void {
	const fetchAsset = options.fetch ?? ((url: string) => fetch(url))
	const storage = "caches" in options ? options.caches : typeof caches === "undefined" ? undefined : caches
	const base = options.base ?? (typeof location === "undefined" ? undefined : location.href)
	const dictionaries = new Map<string, Promise<SpellDictionary>>()
	let engine: Promise<SpellEngine> | undefined
	let wasmUrl: string | undefined

	// A failed start is forgotten, so the next load tries again.
	const startEngine = (url: string): Promise<SpellEngine> => {
		const started = fetchAsset(url).then(response => {
			if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`)

			return WebAssembly.compileStreaming(response).then(module => SpellEngine.instantiate(module))
		})

		engine = started
		started.catch(() => {
			if (engine === started) engine = undefined
		})

		return started
	}

	const reply = (response: SpellcheckResponse, transfer: readonly Transferable[] = []): void => {
		scope.post(response, transfer)
	}

	const absolute = (url: string): string => (base === undefined ? url : new URL(url, base).href)

	const openCache = async (): Promise<Cache | undefined> => {
		try {
			return await storage?.open(SPELLCHECK_CACHE)
		} catch {
			// Cache Storage can be unavailable (private modes, storage pressure): load without it.
			return undefined
		}
	}

	// Drops cached files this build no longer references (another build's dictionaries).
	const prune = async (current: readonly string[]): Promise<void> => {
		const cache = await openCache()

		if (cache === undefined) return

		const keep = new Set(current.map(absolute))

		for (const request of await cache.keys()) {
			if (!keep.has(request.url)) await cache.delete(request)
		}
	}

	// A response body as `asset.bytes` bytes; with `verify`, checked against the manifest's SHA-256.
	const fill = async (asset: SpellcheckAsset, response: Response, verify: boolean): Promise<Uint8Array<ArrayBuffer>> => {
		if (!response.ok || response.body === null) throw new Error(`${asset.url}: HTTP ${String(response.status)}`)

		const out = new Uint8Array(asset.bytes)
		const reader = await inflated(response.body)
		let offset = 0

		for (;;) {
			const { done, value } = await reader.read()

			if (done) break
			if (offset + value.byteLength > asset.bytes) {
				await reader.cancel()

				throw new Error(`${asset.url} is larger than ${String(asset.bytes)} bytes`)
			}

			out.set(value, offset)
			offset += value.byteLength
		}

		if (offset !== asset.bytes) throw new Error(`${asset.url} is ${String(offset)} bytes, expected ${String(asset.bytes)}`)
		if (verify && hex(await crypto.subtle.digest("SHA-256", out)) !== asset.sha256) {
			throw new Error(`${asset.url} does not match its SHA-256`)
		}

		return out
	}

	// One file's bytes. A cached copy that no longer reads back is dropped and fetched again.
	const read = async (asset: SpellcheckAsset): Promise<Uint8Array<ArrayBuffer>> => {
		const cache = await openCache()
		const cached = await cache?.match(asset.url).catch(() => undefined)

		if (cached !== undefined) {
			try {
				return await fill(asset, cached, false)
			} catch {
				await cache?.delete(asset.url).catch(() => undefined)
			}
		}

		const response = await fetchAsset(asset.url)
		// The network copy is cached only once its content proved right.
		const copy = cache !== undefined && response.ok ? response.clone() : undefined
		let bytes: Uint8Array<ArrayBuffer>

		try {
			bytes = await fill(asset, response, true)
		} catch (error) {
			await copy?.body?.cancel()

			throw error
		}

		if (copy !== undefined) await cache?.put(asset.url, copy).catch(() => undefined)

		return bytes
	}

	// The files are read into the worker's own memory first, and copied into the module in one synchronous
	// step: the module's scratch region serves every request, so it cannot hold a file across awaits.
	const load = async (files: SpellcheckDictionaryAssets, words: readonly string[]): Promise<SpellDictionary> => {
		if (wasmUrl === undefined) throw new Error("The spellcheck worker was not initialised")

		const wasm = await (engine ?? startEngine(wasmUrl))
		const [aff, dic] = await Promise.all([read(files.aff), read(files.dic)])
		const dictionary = wasm.load(aff, dic)

		if (dictionary === undefined) throw new Error("The dictionary does not parse")

		for (const word of words) dictionary.add(word)

		return dictionary
	}

	const loaded = (name: string): Promise<SpellDictionary> => dictionaries.get(name) ?? Promise.reject(new Error(`${name} is not loaded`))

	const handle = async (request: SpellcheckRequest): Promise<void> => {
		switch (request.type) {
			case "init":
				wasmUrl = request.wasm
				void (engine ?? startEngine(request.wasm)).catch(() => undefined)
				// Not awaited: pruning never delays a load.
				void prune([request.wasm, ...request.current]).catch(() => undefined)

				return
			case "load": {
				let dictionary = dictionaries.get(request.dictionary)

				if (dictionary === undefined) {
					dictionary = load(request.files, request.words)
					dictionaries.set(request.dictionary, dictionary)
					// A failed load is forgotten, so the host can ask again.
					dictionary.catch(() => {
						if (dictionaries.get(request.dictionary) === dictionary) dictionaries.delete(request.dictionary)
					})
				}

				await dictionary
				reply({ type: "loaded", id: request.id })

				return
			}
			case "check": {
				const verdicts = (await loaded(request.dictionary)).checkJoined(request.words, request.count)

				reply({ type: "checked", id: request.id, verdicts }, [verdicts.buffer])

				return
			}
			case "suggest": {
				const suggestions = (await loaded(request.dictionary)).suggest(request.word, request.ngram)

				reply({ type: "suggested", id: request.id, suggestions })

				return
			}
			case "add":
				for (const dictionary of dictionaries.values()) {
					void dictionary.then(
						loadedDictionary => {
							for (const word of request.words) loadedDictionary.add(word)
						},
						() => undefined
					)
				}

				return
		}
	}

	scope.listen(request => {
		handle(request).catch((error: unknown) => {
			if ("id" in request) reply({ type: "failed", id: request.id, message: message(error) })
		})
	})
}
