import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { WASM_PATH } from "../../scripts/build-wasm.mjs"
import type { SpellcheckAsset, SpellcheckAssets, SpellcheckPort, SpellcheckRequest, SpellcheckResponse } from "../protocol"
import { serveSpellcheckWorker, type SpellcheckWorkerOptions } from "../worker"

// Built by `pnpm run build:dictionaries` (not committed); tests over shipped dictionaries skip without it.
export const DICTIONARIES_DIR = new URL("../../.dictionaries/", import.meta.url)
export const MANIFEST_URL = new URL("../../dictionaries/manifest.json", import.meta.url)

export function dictionariesBuilt(): boolean {
	return existsSync(new URL(".complete", DICTIONARIES_DIR))
}

export const TINY_AFF = "SET UTF-8\nTRY esianrtolcdugmphbyfvkwz\nREP 1\nREP f ph\nSFX S Y 1\nSFX S 0 s .\n"
export const TINY_DIC = "5\nhello\nworld/S\ncafé\nphone\nspell/S\n"
// A dictionary where the fast pass finds nothing for "spelign" and the n-gram pass finds "spelling".
export const NGRAM_AFF = "SET UTF-8\nTRY esianrtolcdugmphbyfvkwz\n"
export const NGRAM_DIC = "2\nmonitor\nspelling\n"

export const BASE = "https://app.test/"

export function wasmBytes(): Uint8Array<ArrayBuffer> {
	return new Uint8Array(readFileSync(WASM_PATH))
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

export function readDictionary(id: string): { aff: Uint8Array; dic: Uint8Array } {
	return {
		aff: new Uint8Array(readFileSync(new URL(`${id}/${id}.aff`, DICTIONARIES_DIR))),
		dic: new Uint8Array(readFileSync(new URL(`${id}/${id}.dic`, DICTIONARIES_DIR)))
	}
}

// Files served by a fake origin: path -> body (gzip for dictionary files, as the app serves them).
export interface FakeOrigin {
	readonly fetch: (url: string) => Promise<Response>
	readonly requests: string[]
	readonly files: Map<string, { body: Uint8Array; type: string }>
}

export function fakeOrigin(): FakeOrigin {
	const files = new Map<string, { body: Uint8Array; type: string }>()
	const requests: string[] = []

	return {
		files,
		requests,
		fetch: url => {
			const absolute = new URL(url, BASE).href

			requests.push(absolute)

			const file = files.get(absolute)

			return Promise.resolve(
				file === undefined
					? new Response("missing", { status: 404 })
					: new Response(file.body.slice(), { headers: { "Content-Type": file.type } })
			)
		}
	}
}

// Serves `text` gzip-compressed at `path`; returns the manifest entry the host passes.
// Uncompressed when `compress` is false (a host that decoded a Content-Encoding itself).
export function serveText(origin: FakeOrigin, path: string, text: string | Uint8Array, compress: boolean = true): SpellcheckAsset {
	const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text

	origin.files.set(new URL(path, BASE).href, {
		body: compress ? new Uint8Array(gzipSync(bytes)) : bytes,
		type: "application/octet-stream"
	})

	return { url: path, bytes: bytes.byteLength, sha256: sha256(bytes) }
}

export function tinyAssets(origin: FakeOrigin): SpellcheckAssets {
	origin.files.set(new URL("/spell.wasm", BASE).href, { body: wasmBytes(), type: "application/wasm" })

	return {
		wasm: "/spell.wasm",
		dictionaries: {
			en_US: { aff: serveText(origin, "/en.aff.gz", TINY_AFF), dic: serveText(origin, "/en.dic.gz", TINY_DIC) },
			de_DE: {
				aff: serveText(origin, "/de.aff.gz", "SET UTF-8\n"),
				dic: serveText(origin, "/de.dic.gz", "2\nStraße\nHaus\n")
			}
		}
	}
}

// Cache Storage calls that answer with a rejected promise (unavailable storage, quota exceeded).
export interface CacheFailures {
	readonly open?: "reject"
	readonly match?: "reject"
	readonly put?: "reject"
}

// A minimal Cache Storage (one cache per name, keyed by absolute URL).
export function memoryCaches(failures: CacheFailures = {}): CacheStorage & { stored: Map<string, Map<string, Response>> } {
	const stored = new Map<string, Map<string, Response>>()
	const cacheOf = (name: string): Cache => {
		let entries = stored.get(name)

		if (entries === undefined) {
			entries = new Map()
			stored.set(name, entries)
		}

		const map = entries
		const key = (request: RequestInfo | URL): string =>
			new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, BASE).href

		return {
			match: (request: RequestInfo | URL) =>
				failures.match === "reject" ? Promise.reject(new Error("match failed")) : Promise.resolve(map.get(key(request))?.clone()),
			put: async (request: RequestInfo | URL, response: Response) => {
				if (failures.put === "reject") throw new DOMException("Quota exceeded", "QuotaExceededError")

				map.set(key(request), new Response(await response.arrayBuffer(), { headers: response.headers }))
			},
			keys: () => Promise.resolve([...map.keys()].map(url => new Request(url))),
			delete: (request: RequestInfo | URL) => Promise.resolve(map.delete(key(request)))
		} as unknown as Cache
	}

	return {
		stored,
		open: (name: string) => (failures.open === "reject" ? Promise.reject(new Error("open failed")) : Promise.resolve(cacheOf(name)))
	} as unknown as CacheStorage & { stored: Map<string, Map<string, Response>> }
}

// A worker served in this thread; messages cross a macrotask each way, as they would between threads.
export interface InThreadWorker extends SpellcheckPort {
	readonly received: SpellcheckRequest[]
	readonly terminated: boolean
	// The worker dies on its own (a failed script, out of memory): nothing more is delivered either way and
	// the host hears the error. terminated stays as the host left it.
	crash(): void
}

export function inThreadWorker(options: SpellcheckWorkerOptions): InThreadWorker {
	let toWorker: ((message: SpellcheckRequest) => void) | undefined
	let toHost: ((message: SpellcheckResponse) => void) | undefined
	let fail: (() => void) | undefined
	let terminated = false
	let crashed = false
	const received: SpellcheckRequest[] = []

	serveSpellcheckWorker(
		{
			post: message => {
				setTimeout(() => {
					if (!terminated && !crashed) toHost?.(message)
				})
			},
			listen: onMessage => {
				toWorker = onMessage
			}
		},
		{ base: BASE, ...options }
	)

	return {
		received,
		get terminated() {
			return terminated
		},
		post: message => {
			received.push(message)
			setTimeout(() => {
				if (!terminated && !crashed) toWorker?.(message)
			})
		},
		listen: (onMessage, onError) => {
			toHost = onMessage
			fail = onError
		},
		crash: () => {
			crashed = true
			fail?.()
		},
		terminate: () => {
			terminated = true
		}
	}
}
