import { modelFileUrl, type AssistantModelFile, type AssistantModelFiles } from "./manifest"

// The resumable, verified shard download, written against small interfaces so it runs on OPFS sync
// access handles in the web worker, on plain files in the desktop app's engine process, and on in-memory
// fakes in tests.
//
// The model host only allows simple CORS requests (no preflight: it answers OPTIONS with 405) and does not
// expose Content-Range. So the only request header ever sent is a single "Range: bytes=N-", which is
// CORS-safelisted, and a resumed response is recognized by status 206 and its Content-Length alone.
//
// Every byte is hashed once, as it arrives. A checkpoint beside each partial shard holds the hasher's state
// at a flushed offset, so a resumed shard re-reads at most what arrived after the last checkpoint.

// The subset of FileSystemSyncAccessHandle the download uses.
export interface ShardFile {
	getSize(): number
	truncate(size: number): void
	read(buffer: Uint8Array, options: { at: number }): number
	write(buffer: Uint8Array, options: { at: number }): number
	flush(): void
}

export interface StreamingHasher {
	init(): unknown
	update(data: Uint8Array): unknown
	digest(outputType: "hex"): string
	// The running state, and back (hash-wasm); load throws on a state it did not produce.
	save(): Uint8Array
	load(state: Uint8Array): unknown
}

export interface Connectivity {
	isOnline(): boolean
	// Settles once the browser reports a connection again, or rejects when `signal` aborts.
	waitOnline(signal: AbortSignal): Promise<void>
}

export type ModelDownloadErrorKind = "network" | "integrity" | "storage-full"

export class ModelDownloadError extends Error {
	readonly kind: ModelDownloadErrorKind

	constructor(kind: ModelDownloadErrorKind, message: string) {
		super(message)
		this.name = `ModelDownloadError:${kind}`
		this.kind = kind
	}
}

const READ_CHUNK = 8 * 1024 * 1024
// Durability checkpoint: what a crash can lose of a shard, and what a resume re-reads at most.
const FLUSH_EVERY = 32 * 1024 * 1024
// A response that delivers nothing for this long is abandoned and resumed with a Range request: a stalled
// HTTP/2 stream, or one a frozen background tab left behind, never errors on its own. A live stream
// delivers a chunk at least every second even on a slow link.
export const STALL_MS = 15_000
// Attempts in a row that brought no new byte (stalls, network errors, 5xx) before the shard fails. With
// the backoff below that is about two minutes of trying; time spent offline does not count.
const MAX_FRUITLESS_ATTEMPTS = 8
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
// Shards in flight. They share one HTTP/2 connection, so more do not add bandwidth; they keep it busy while
// one stream stalls or waits on its first byte.
const PARALLEL_SHARDS = 3

// Chromium raises it from write() or only from the next flush(), and as its own DOMException subclass.
function isQuotaError(e: unknown): boolean {
	return e instanceof Error && e.name === "QuotaExceededError"
}

// Equal jitter: at least half the exponential step, so retries never bunch up at zero.
export function retryDelayMs(failures: number, random: () => number = Math.random): number {
	const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1))

	return Math.round(step / 2 + (random() * step) / 2)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason as Error)

			return
		}

		const onAbort = () => {
			clearTimeout(timer)
			reject(signal.reason as Error)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolve()
		}, ms)

		signal.addEventListener("abort", onAbort, { once: true })
	})
}

// [offset][hasher state][offset again], offsets as float64 LE: a record torn by a crash mid-write shows as
// two offsets that differ. The final digest is checked against the manifest either way, so a bad
// checkpoint can only cost a refetch, never let a wrong byte through.
const OFFSET_BYTES = 8

function readCheckpoint({ checkpoint, hasher, size }: { checkpoint: ShardFile; hasher: StreamingHasher; size: number }): number {
	const length = checkpoint.getSize()

	if (length <= 2 * OFFSET_BYTES) {
		return 0
	}

	const record = new Uint8Array(length)

	if (checkpoint.read(record, { at: 0 }) !== length) {
		return 0
	}

	const view = new DataView(record.buffer)
	const offset = view.getFloat64(0, true)

	if (offset !== view.getFloat64(length - OFFSET_BYTES, true) || !Number.isSafeInteger(offset) || offset < 0 || offset > size) {
		return 0
	}

	try {
		hasher.load(record.subarray(OFFSET_BYTES, length - OFFSET_BYTES))
	} catch {
		hasher.init()

		return 0
	}

	return offset
}

// Only after the shard's bytes up to `offset` are flushed: the record must never get ahead of the data.
function writeCheckpoint({ checkpoint, hasher, offset }: { checkpoint: ShardFile; hasher: StreamingHasher; offset: number }): void {
	const state = hasher.save()
	const record = new Uint8Array(2 * OFFSET_BYTES + state.length)
	const view = new DataView(record.buffer)

	view.setFloat64(0, offset, true)
	record.set(state, OFFSET_BYTES)
	view.setFloat64(record.length - OFFSET_BYTES, offset, true)
	// Over the old record, never truncated to zero first: the record keeps its size, so there is no moment
	// with no checkpoint at all.
	checkpoint.write(record, { at: 0 })
	checkpoint.truncate(record.length)
	checkpoint.flush()
}

// Hashes what lies on disk past the checkpoint (at most FLUSH_EVERY, unless the checkpoint was lost).
function hashFrom({ file, from, size, hasher }: { file: ShardFile; from: number; size: number; hasher: StreamingHasher }): void {
	if (from >= size) {
		return
	}

	const buffer = new Uint8Array(Math.min(READ_CHUNK, size - from))

	for (let at = from; at < size; at += buffer.length) {
		const view = buffer.subarray(0, Math.min(buffer.length, size - at))

		if (file.read(view, { at }) !== view.length) {
			throw new ModelDownloadError("network", "Short read of a partial shard")
		}

		hasher.update(view)
	}
}

class RetryableError extends Error {}

function isRetryableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429
}

// One request for the rest of the shard from `from`, written and hashed as it arrives, until the shard's
// published size is on disk. Throws RetryableError when the attempt may be repeated from the bytes it
// left (a stall, a dropped connection, a 5xx); everything it delivered is flushed and checkpointed first.
async function fetchRange({
	shard,
	url,
	file,
	checkpoint,
	hasher,
	fetchShard,
	signal,
	onSize,
	from
}: {
	shard: AssistantModelFile
	url: string
	file: ShardFile
	checkpoint: ShardFile
	hasher: StreamingHasher
	fetchShard: (url: string, init: RequestInit) => Promise<Response>
	signal: AbortSignal
	onSize: (size: number) => void
	from: number
}): Promise<number> {
	let size = from
	let checkpointed = from
	const stall = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const arm = () => {
		clearTimeout(timer)
		timer = setTimeout(() => {
			stall.abort()
		}, STALL_MS)
	}
	const checkpointNow = () => {
		file.flush()

		if (size > checkpointed) {
			writeCheckpoint({ checkpoint, hasher, offset: size })
			checkpointed = size
		}
	}

	arm()

	try {
		const response = await fetchShard(url, {
			signal: AbortSignal.any([signal, stall.signal]),
			credentials: "omit",
			// The shard lands on disk (OPFS or a file); a second copy in the HTTP cache would only take disk.
			cache: "no-store",
			...(size > 0 ? { headers: { Range: `bytes=${String(size)}-` } } : {})
		})

		if (size > 0 && response.status === 200) {
			// The host ignored the range: start the shard over.
			file.truncate(0)
			checkpoint.truncate(0)
			hasher.init()
			size = 0
			checkpointed = 0
			onSize(0)
		} else if (response.status !== (size > 0 ? 206 : 200)) {
			void response.body?.cancel().catch(() => undefined)

			if (isRetryableStatus(response.status)) {
				throw new RetryableError(`Fetching ${shard.file} answered ${String(response.status)}`)
			}

			throw new ModelDownloadError("network", `Fetching ${shard.file} answered ${String(response.status)}`)
		}

		const length = Number(response.headers.get("Content-Length") ?? Number.NaN)

		if (!Number.isNaN(length) && length !== shard.size - size) {
			void response.body?.cancel().catch(() => undefined)

			throw new ModelDownloadError("network", `${shard.file} has an unexpected length`)
		}

		if (response.body === null) {
			throw new ModelDownloadError("network", `${shard.file} has no body`)
		}

		const reader = response.body.getReader()

		try {
			// Ends at the published size, not at the stream's end: a response whose last DATA frame arrived
			// but whose end-of-stream lags would otherwise hold the shard until the stall timer fired.
			while (size < shard.size) {
				arm()

				const { done, value } = await reader.read()

				if (done) {
					throw new RetryableError(`${shard.file} ended early`)
				}

				if (size + value.length > shard.size) {
					throw new ModelDownloadError("integrity", `${shard.file} is longer than published`)
				}

				file.write(value, { at: size })
				hasher.update(value)
				size += value.length
				onSize(size)

				if (size - checkpointed >= FLUSH_EVERY) {
					checkpointNow()
				}
			}
		} finally {
			// Releases the stream at once, also when it is still open past the last byte.
			void reader.cancel().catch(() => undefined)
		}

		return size
	} catch (e) {
		if (signal.aborted || e instanceof ModelDownloadError || e instanceof RetryableError || isQuotaError(e)) {
			throw e
		}

		if (stall.signal.aborted) {
			throw new RetryableError(`${shard.file} stalled`)
		}

		// A dropped connection: fetch() rejects with a TypeError, a broken body read with a network error.
		throw new RetryableError(`Fetching ${shard.file} failed: ${e instanceof Error ? e.message : String(e)}`)
	} finally {
		clearTimeout(timer)
		checkpointNow()
	}
}

// Downloads one shard into `file` (resuming from its current size and the checkpoint), verifying its
// sha256 as the bytes arrive. Leaves a complete, verified shard, or throws; an integrity failure leaves
// the file empty, anything else leaves it resumable.
export async function downloadShard({
	shard,
	url,
	file,
	checkpoint,
	hasher,
	fetchShard,
	signal,
	connectivity,
	onSize,
	onWaiting,
	random = Math.random
}: {
	shard: AssistantModelFile
	url: string
	file: ShardFile
	checkpoint: ShardFile
	hasher: StreamingHasher
	fetchShard: (url: string, init: RequestInit) => Promise<Response>
	signal: AbortSignal
	connectivity: Connectivity
	// The shard's bytes on disk, absolute; never above shard.size.
	onSize: (size: number) => void
	// Whether the shard is waiting (offline, or backing off) rather than transferring.
	onWaiting: (waiting: boolean) => void
	random?: () => number
}): Promise<void> {
	let size = file.getSize()

	if (size > shard.size) {
		file.truncate(0)
		checkpoint.truncate(0)
		size = 0
	}

	hasher.init()
	hashFrom({ file, from: readCheckpoint({ checkpoint, hasher, size }), size, hasher })
	onSize(size)

	// Counts attempts in a row that brought nothing; a slow shard that keeps moving is never given up on.
	let fruitless = 0

	try {
		while (size < shard.size) {
			if (!connectivity.isOnline()) {
				onWaiting(true)
				await connectivity.waitOnline(signal)
				onWaiting(false)
			}

			const before = size

			try {
				size = await fetchRange({ shard, url, file, checkpoint, hasher, fetchShard, signal, onSize, from: size })
			} catch (e) {
				if (!(e instanceof RetryableError) || signal.aborted) {
					throw e
				}

				size = file.getSize()

				// Gone offline mid-transfer: the next pass waits for the connection without counting it.
				if (!connectivity.isOnline()) {
					continue
				}

				fruitless = size > before ? 0 : fruitless + 1

				if (fruitless >= MAX_FRUITLESS_ATTEMPTS) {
					throw new ModelDownloadError("network", `${shard.file} stopped arriving: ${e.message}`)
				}

				if (fruitless > 0) {
					onWaiting(true)
					await sleep(retryDelayMs(fruitless, random), signal)
					onWaiting(false)
				}
			}
		}

		if (hasher.digest("hex") !== shard.sha256) {
			throw new ModelDownloadError("integrity", `${shard.file} does not match its published hash`)
		}

		checkpoint.truncate(0)
		checkpoint.flush()
	} catch (e) {
		if (e instanceof ModelDownloadError && e.kind === "integrity") {
			file.truncate(0)
			file.flush()
			checkpoint.truncate(0)
			checkpoint.flush()
			onSize(0)
		}

		throw e
	} finally {
		onWaiting(false)
	}
}

export interface ShardStore {
	isVerified(shard: AssistantModelFile): boolean
	// The shard file's size as found when the store was opened (a partial download continues from it).
	sizeOnDisk(shard: AssistantModelFile): number
	markVerified(shard: AssistantModelFile): Promise<void>
	// Opens the shard's file and its checkpoint for the duration of `run`.
	withFile<T>(shard: AssistantModelFile, run: (file: ShardFile, checkpoint: ShardFile) => Promise<T>): Promise<T>
}

export interface ModelDownloadProgress {
	// Bytes of the model on disk; exact, never above the manifest's total.
	receivedBytes: number
	// No shard is moving: offline, or every shard in flight is backing off after an error.
	waiting: boolean
}

// Downloads every shard not yet verified, largest first and PARALLEL_SHARDS at a time, reporting the bytes
// on disk as they change. A shard whose hash mismatches is fetched once more from scratch before the
// download fails.
export async function downloadModelShards({
	manifest,
	baseUrl,
	store,
	createHasher,
	fetchShard,
	connectivity,
	signal,
	onProgress,
	random = Math.random
}: {
	manifest: AssistantModelFiles
	baseUrl: string
	store: ShardStore
	createHasher: () => Promise<StreamingHasher>
	fetchShard: (url: string, init: RequestInit) => Promise<Response>
	connectivity: Connectivity
	signal: AbortSignal
	onProgress: (progress: ModelDownloadProgress) => void
	random?: () => number
}): Promise<void> {
	// Each pending shard's bytes on disk; the total is recomputed from absolutes, so no retry, restart or
	// resume can count a byte twice.
	const onDisk = new Map<string, number>()
	let received = 0
	let waitingShards = 0
	let activeShards = 0
	const report = () => {
		onProgress({ receivedBytes: received, waiting: activeShards > 0 && waitingShards === activeShards })
	}
	const pending: AssistantModelFile[] = []

	for (const shard of manifest.shards) {
		if (store.isVerified(shard)) {
			received += shard.size
		} else {
			const partial = Math.min(store.sizeOnDisk(shard), shard.size)

			onDisk.set(shard.file, partial)
			received += partial
			pending.push(shard)
		}
	}

	// Longest first: the short shards fill the gaps at the end instead of one long shard running alone.
	pending.sort((a, b) => b.size - a.size)
	report()

	// One failed shard stops the others in flight.
	const failed = new AbortController()
	const shardSignal = AbortSignal.any([signal, failed.signal])
	const worker = async () => {
		const hasher = await createHasher()

		for (let shard = pending.shift(); shard !== undefined; shard = pending.shift()) {
			const current = shard
			let waiting = false

			activeShards++

			const onSize = (size: number) => {
				received += Math.min(size, current.size) - (onDisk.get(current.file) ?? 0)
				onDisk.set(current.file, Math.min(size, current.size))
				report()
			}
			const onWaiting = (next: boolean) => {
				if (next === waiting) {
					return
				}

				waiting = next
				waitingShards += next ? 1 : -1
				report()
			}

			try {
				for (let attempt = 0; ; attempt++) {
					shardSignal.throwIfAborted()

					try {
						await store.withFile(current, (file, checkpoint) =>
							downloadShard({
								shard: current,
								url: modelFileUrl({ baseUrl, file: current }),
								file,
								checkpoint,
								hasher,
								fetchShard,
								signal: shardSignal,
								connectivity,
								onSize,
								onWaiting,
								random
							})
						)

						break
					} catch (e) {
						if (isQuotaError(e)) {
							throw new ModelDownloadError("storage-full", "Storage is full")
						}

						if (attempt > 0 || !(e instanceof ModelDownloadError) || e.kind !== "integrity") {
							throw e
						}
					}
				}
			} finally {
				activeShards--
			}

			await store.markVerified(current).catch((e: unknown) => {
				throw isQuotaError(e) ? new ModelDownloadError("storage-full", "Storage is full") : e
			})
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(PARALLEL_SHARDS, pending.length) }, () =>
			worker().catch((e: unknown) => {
				failed.abort()

				throw e
			})
		)
	)
}

// A web worker's view of navigator.onLine and its "online" event.
export function globalConnectivity(
	scope: { navigator: { onLine: boolean } } & Pick<EventTarget, "addEventListener" | "removeEventListener">
): Connectivity {
	return {
		isOnline: () => scope.navigator.onLine,
		waitOnline: signal =>
			new Promise((resolve, reject) => {
				const done = () => {
					scope.removeEventListener("online", done)
					signal.removeEventListener("abort", aborted)
					resolve()
				}
				const aborted = () => {
					scope.removeEventListener("online", done)
					reject(signal.reason as Error)
				}

				if (signal.aborted) {
					reject(signal.reason as Error)

					return
				}

				scope.addEventListener("online", done)
				signal.addEventListener("abort", aborted, { once: true })
			})
	}
}
