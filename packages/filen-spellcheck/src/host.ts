import { dictionaryFor } from "./languages"
import { WORD_SEPARATOR, type SpellcheckAssets, type SpellcheckPort, type SpellcheckRequest, type SpellcheckResponse } from "./protocol"

// The page's side of spellchecking: verdicts cached per dictionary (a document repeats its words: about
// 12k unique among 84k), checks batched to a worker that keeps the dictionaries loaded, and suggestions
// from a second worker that is terminated when a slow request is superseded or overruns. Workers end
// after a quiet spell or once no document is open; wasm memory never shrinks, so ending the worker is how a
// dictionary's memory goes.

export interface SpellcheckHostOptions {
	readonly assets: SpellcheckAssets
	readonly createWorker: () => SpellcheckPort
	// Quiet time before a worker ends (ms).
	readonly checkIdleMs?: number
	readonly suggestIdleMs?: number
	// A suggestion request that runs longer is abandoned (its worker terminated) and answers [] (ms).
	readonly suggestTimeoutMs?: number
	readonly now?: () => number
}

export interface SuggestOptions {
	// Also run the n-gram pass (slow on large dictionaries): for "more suggestions" or when the fast pass
	// found nothing.
	readonly more?: boolean
	readonly signal?: AbortSignal
}

const CHECK_IDLE_MS = 120_000
const SUGGEST_IDLE_MS = 30_000
const SUGGEST_TIMEOUT_MS = 3_000
// A dictionary that failed to load is not fetched again before this, doubling per failure up to the cap (ms).
const LOAD_RETRY_MS = 15_000
const LOAD_RETRY_MAX_MS = 300_000
// Words per check message: large enough to amortise a round trip, small enough to interleave dictionaries.
const BATCH = 4096
// Verdicts kept per dictionary; past this the cache starts over (a document rarely has more unique words).
const MAX_VERDICTS = 200_000
const MAX_SUGGESTION_ENTRIES = 64
// Longer "words" (identifiers, encoded data) are not checked.
export const MAX_WORD_LENGTH = 100

export class SpellcheckAbortError extends Error {
	constructor() {
		super("Spellcheck request superseded")
		this.name = "AbortError"
	}
}

interface Pending {
	resolve: (response: SpellcheckResponse) => void
	reject: (error: unknown) => void
}

// One worker and the dictionaries it was asked to load.
class WorkerSlot {
	private port: SpellcheckPort | undefined
	private readonly pending = new Map<number, Pending>()
	private readonly loads = new Map<string, Promise<void>>()
	private nextId = 1
	private timer: ReturnType<typeof setTimeout> | undefined
	private readonly host: SpellcheckHost
	private readonly idleMs: number

	constructor(host: SpellcheckHost, idleMs: number) {
		this.host = host
		this.idleMs = idleMs
	}

	get alive(): boolean {
		return this.port !== undefined
	}

	get busy(): boolean {
		return this.pending.size > 0
	}

	private open(): SpellcheckPort {
		if (this.port !== undefined) return this.port

		const port = this.host.options.createWorker()
		const assets = this.host.options.assets
		const current = Object.values(assets.dictionaries).flatMap(files => [files.aff.url, files.dic.url])

		this.port = port
		port.listen(
			response => {
				if (this.port === port) this.settle(response)
			},
			() => {
				if (this.port === port) this.terminate(new Error("The spellcheck worker failed"))
			}
		)
		port.post({ type: "init", wasm: assets.wasm, current }, [])

		return port
	}

	private settle(response: SpellcheckResponse): void {
		const pending = this.pending.get(response.id)

		if (pending === undefined) return

		this.pending.delete(response.id)

		if (response.type === "failed") pending.reject(new Error(response.message))
		else pending.resolve(response)

		if (this.pending.size === 0) this.arm()
	}

	private arm(): void {
		clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			if (this.pending.size === 0) this.terminate(new SpellcheckAbortError())
		}, this.idleMs)
	}

	request(build: (id: number) => SpellcheckRequest, transfer: readonly Transferable[] = []): Promise<SpellcheckResponse> {
		const port = this.open()
		const id = this.nextId++

		clearTimeout(this.timer)

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			port.post(build(id), transfer)
		})
	}

	ensure(dictionary: string): Promise<void> {
		let load = this.loads.get(dictionary)

		if (load === undefined) {
			const files = this.host.options.assets.dictionaries[dictionary]

			if (files === undefined) return Promise.reject(new Error(`No dictionary ${dictionary}`))

			const failure = this.host.loadFailure(dictionary)

			if (failure !== undefined) return Promise.reject(failure)

			load = this.request(id => ({ type: "load", id, dictionary, files, words: [...this.host.userWords] })).then(
				() => this.host.loaded(dictionary),
				(error: unknown) => {
					// A terminated worker is not the dictionary's fault.
					if (!(error instanceof SpellcheckAbortError)) this.host.failedToLoad(dictionary, error)

					throw error
				}
			)
			this.loads.set(dictionary, load)
			load.catch(() => {
				if (this.loads.get(dictionary) === load) this.loads.delete(dictionary)
			})
		}

		return load
	}

	add(words: readonly string[]): void {
		if (this.port !== undefined && this.loads.size > 0) this.port.post({ type: "add", words }, [])
	}

	terminate(reason: unknown): void {
		clearTimeout(this.timer)
		this.port?.terminate()
		this.port = undefined
		this.loads.clear()

		const pending = [...this.pending.values()]

		this.pending.clear()

		for (const { reject } of pending) reject(reason)
	}
}

export class SpellcheckHost {
	/** @internal */
	readonly options: SpellcheckHostOptions
	/** @internal */
	userWords = new Set<string>()
	private readonly checker: WorkerSlot
	private readonly suggester: WorkerSlot
	private readonly verdicts = new Map<string, Map<string, boolean>>()
	private readonly inflight = new Map<string, Map<string, Promise<void>>>()
	private readonly suggestions = new Map<string, readonly string[]>()
	private readonly listeners = new Set<() => void>()
	// Bumped when verdicts may change (the user's words): answers to older requests are not cached.
	private generation = 0
	// The suggestion request running in the suggest worker, so a newer one can abandon it.
	private running: { readonly slow: boolean; readonly abort: () => void } | undefined = undefined
	private disposed = false
	// Documents being checked (open()); once none is, nothing is kept.
	private documents = 0
	private readonly loadFailures = new Map<string, { readonly until: number; readonly delay: number; readonly error: unknown }>()

	constructor(options: SpellcheckHostOptions) {
		this.options = options
		this.checker = new WorkerSlot(this, options.checkIdleMs ?? CHECK_IDLE_MS)
		this.suggester = new WorkerSlot(this, options.suggestIdleMs ?? SUGGEST_IDLE_MS)
	}

	/** @internal */
	loadFailure(dictionary: string): unknown {
		const failure = this.loadFailures.get(dictionary)

		return failure !== undefined && this.now() < failure.until ? failure.error : undefined
	}

	/** @internal */
	failedToLoad(dictionary: string, error: unknown): void {
		const delay = Math.min((this.loadFailures.get(dictionary)?.delay ?? LOAD_RETRY_MS / 2) * 2, LOAD_RETRY_MAX_MS)

		this.loadFailures.set(dictionary, { until: this.now() + delay, delay, error })
	}

	/** @internal */
	loaded(dictionary: string): void {
		this.loadFailures.delete(dictionary)
	}

	private now(): number {
		return (this.options.now ?? Date.now)()
	}

	// The dictionary for a language tag (w:lang, BCP 47), when this build ships one.
	dictionaryFor(language: string): string | undefined {
		const id = dictionaryFor(language)

		return id !== undefined && id in this.options.assets.dictionaries ? id : undefined
	}

	// The cached verdict for a word; undefined until checked.
	known(dictionary: string, word: string): boolean | undefined {
		return this.verdicts.get(dictionary)?.get(word)
	}

	// Checks the words without a cached verdict (known() answers for them afterwards). Rejects when the
	// dictionary could not be loaded.
	async check(dictionary: string, words: Iterable<string>): Promise<void> {
		if (this.disposed) return

		let flight = this.inflight.get(dictionary)

		if (flight === undefined) {
			flight = new Map()
			this.inflight.set(dictionary, flight)
		}

		const cache = this.verdicts.get(dictionary)
		const waits = new Set<Promise<void>>()
		const fresh: string[] = []

		for (const word of words) {
			if (cache?.has(word)) continue

			const running = flight.get(word)

			if (running !== undefined) waits.add(running)
			else if (word.length === 0 || word.length > MAX_WORD_LENGTH || word.includes(WORD_SEPARATOR)) this.store(dictionary, word, true)
			else {
				fresh.push(word)
				// Marked before the batch exists, so duplicates within `words` are skipped.
				flight.set(word, Promise.resolve())
			}
		}

		for (let start = 0; start < fresh.length; start += BATCH) {
			const batch = fresh.slice(start, start + BATCH)
			const promise = this.checkBatch(dictionary, batch).finally(() => {
				for (const word of batch) {
					if (flight.get(word) === promise) flight.delete(word)
				}
			})

			for (const word of batch) flight.set(word, promise)

			waits.add(promise)
		}

		await Promise.all(waits)
	}

	private async checkBatch(dictionary: string, words: readonly string[]): Promise<void> {
		const generation = this.generation

		await this.checker.ensure(dictionary)

		const response = await this.checker.request(id => ({
			type: "check",
			id,
			dictionary,
			words: words.join(WORD_SEPARATOR),
			count: words.length
		}))

		if (response.type !== "checked" || generation !== this.generation) return

		const verdicts = response.verdicts

		for (let i = 0; i < words.length; i++) this.store(dictionary, words[i] ?? "", verdicts[i] === 1)
	}

	private store(dictionary: string, word: string, correct: boolean): void {
		let cache = this.verdicts.get(dictionary)

		if (cache === undefined) {
			cache = new Map()
			this.verdicts.set(dictionary, cache)
		} else if (cache.size >= MAX_VERDICTS) {
			cache.clear()
		}

		cache.set(word, correct)
	}

	// Corrections for a word, best first. A newer request abandons an older slow one; a request that overruns
	// the time limit answers [] (its worker is replaced).
	async suggest(dictionary: string, word: string, options: SuggestOptions = {}): Promise<readonly string[]> {
		const more = options.more ?? false
		const key = `${dictionary}\u0000${more ? 1 : 0}\u0000${word}`
		const cached = this.suggestions.get(key)

		if (cached !== undefined) return cached
		if (this.disposed || word.length === 0 || word.length > MAX_WORD_LENGTH || word.includes(WORD_SEPARATOR)) return []

		options.signal?.throwIfAborted()

		// Only a slow (n-gram) request is worth a new worker; a fast one finishes first.
		if (this.running?.slow === true) this.running.abort()

		const slot = this.suggester
		const generation = this.generation
		let timer: ReturnType<typeof setTimeout> | undefined
		let timedOut = false
		const abort = (): void => slot.terminate(new SpellcheckAbortError())
		const running = { slow: more, abort }
		const onAbort = (): void => {
			if (this.running === running) abort()
		}

		this.running = running
		options.signal?.addEventListener("abort", onAbort, { once: true })

		try {
			await slot.ensure(dictionary)

			const answer = slot.request(id => ({ type: "suggest", id, dictionary, word, ngram: more }))
			const response = await new Promise<SpellcheckResponse>((resolve, reject) => {
				timer = setTimeout(() => {
					timedOut = true
					abort()
				}, this.options.suggestTimeoutMs ?? SUGGEST_TIMEOUT_MS)
				answer.then(resolve, reject)
			})
			const suggestions = response.type === "suggested" ? response.suggestions : []

			if (generation === this.generation) {
				if (this.suggestions.size >= MAX_SUGGESTION_ENTRIES) {
					const oldest = this.suggestions.keys().next()

					if (oldest.done !== true) this.suggestions.delete(oldest.value)
				}

				this.suggestions.set(key, suggestions)
			}

			return suggestions
		} catch (error) {
			if (timedOut) return []

			throw error
		} finally {
			clearTimeout(timer)
			options.signal?.removeEventListener("abort", onAbort)

			if (this.running === running) this.running = undefined
		}
	}

	// The user's dictionary: accepted in every language. Additions reach the loaded dictionaries; a removal
	// restarts the workers, since a dictionary cannot forget a word.
	setUserWords(words: Iterable<string>): void {
		const next = new Set<string>()

		for (const word of words) {
			if (word.length > 0 && word.length <= MAX_WORD_LENGTH && !word.includes(WORD_SEPARATOR)) next.add(word)
		}

		const added = [...next].filter(word => !this.userWords.has(word))
		const removed = [...this.userWords].some(word => !next.has(word))

		if (added.length === 0 && !removed) return

		this.userWords = next
		this.generation++
		this.suggestions.clear()

		if (removed) {
			this.checker.terminate(new SpellcheckAbortError())
			this.suggester.terminate(new SpellcheckAbortError())
			this.verdicts.clear()
		} else {
			this.checker.add(added)
			this.suggester.add(added)

			// Only rejections can change; an added word's casing variants are too many to enumerate.
			for (const cache of this.verdicts.values()) {
				for (const [word, correct] of cache) {
					if (!correct) cache.delete(word)
				}
			}
		}

		for (const listener of [...this.listeners]) listener()
	}

	// A document starts being checked; the returned call ends that. When the last one ends, the workers end
	// and the cached verdicts and suggestions go: a closed editor holds no dictionary.
	open(): () => void {
		this.documents++

		let open = true

		return () => {
			if (!open) return

			open = false
			this.documents--

			if (this.documents === 0) this.release()
		}
	}

	private release(): void {
		// Answers still on their way are not cached.
		this.generation++
		this.checker.terminate(new SpellcheckAbortError())
		this.suggester.terminate(new SpellcheckAbortError())
		this.verdicts.clear()
		this.inflight.clear()
		this.suggestions.clear()
	}

	// Hears when cached verdicts were dropped (the user's words changed): text should be checked again.
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	dispose(): void {
		this.disposed = true
		this.release()
		this.listeners.clear()
	}
}
