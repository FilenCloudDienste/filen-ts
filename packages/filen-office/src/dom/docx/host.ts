import { bytesSource, type ByteSource } from "../../core/opc/index"
import type { OfficeKeyTransfer } from "../encryption/webCrypto"
import { DocxEngine, type DocxEngineServices } from "./engine"
import type { DocxAnnotations } from "./annotations"
import { docxLegacyServer, type DocxConvertAnswer, type DocxLegacy, type DocxLegacyOpen, type DocxLegacyOptions } from "./legacy"
import {
	heldSource,
	type DocxAbortSignal,
	type DocxDocumentUnlock,
	type DocxProtectedOpen,
	type DocxProtection,
	type DocxProtectionOptions
} from "./protection"
import { docxProtectionServer, type DocxProtectVerdict, type DocxUnlockAnswer } from "./protectionWorker"
import { DocxRtfRefusal, type DocxRtf, type DocxRtfEdits, type DocxRtfOpen, type RtfLockedBlock } from "./rtf"
import { RtfAborted } from "../../core/rtf/write/writer"
import { docxRtfServer, type DocxRtfOpened, type DocxRtfWritten, type DocxSourceFormat } from "./rtfWorker"
import {
	answerOf,
	docxConvertServer,
	type DocxConversion,
	type DocxConverter,
	type TextSourceFormat,
	type TextTargetFormat
} from "./convert"
import type { TextConversion } from "../../core/convert/text/index"
import type { DocxEvent, DocxFindOptions, DocxSessionApi, DocxLocation, DocxMedia, DocxObjectData, DocxOpenOptions } from "./protocol"

// Two ways to run the engine behind the same DocxSessionApi: in a worker (web), talking over a small
// message protocol, or on the calling thread, time-sliced (an Expo DOM component, where workers are not
// assumed). The document's bytes stay with the caller either way: the engine reads the ranges it needs.

export type DocxListener = (event: DocxEvent) => void

// Opens a document; the listener hears every event in order until close().
export type DocxHost = (source: ByteSource, listener: DocxListener, options?: DocxOpenOptions) => DocxSessionApi

interface MessageChannelLike {
	readonly port1: { onmessage: ((event: unknown) => void) | null; close?(): void }
	readonly port2: { postMessage(message: unknown): void; close?(): void }
}

// A macrotask turn, so messages queued for the thread (requests, reads) are handled between layout slices.
// MessageChannel avoids the 4 ms clamp nested timers get; setTimeout is the fallback.
export function macrotaskYield(): () => Promise<void> {
	const Channel: unknown = Reflect.get(globalThis, "MessageChannel")

	if (typeof Channel !== "function") {
		const timer: unknown = Reflect.get(globalThis, "setTimeout")

		return () =>
			new Promise(resolve => {
				if (typeof timer === "function") timer(resolve, 0)
				else resolve()
			})
	}

	const channel = new (Channel as new () => MessageChannelLike)()
	const waiting: (() => void)[] = []

	channel.port1.onmessage = () => {
		waiting.shift()?.()
	}

	// Node keeps a listening port's process alive; nothing here should.
	for (const end of [channel.port1, channel.port2]) {
		const unref: unknown = Reflect.get(end, "unref")

		if (typeof unref === "function") Reflect.apply(unref, end, [])
	}

	return () =>
		new Promise<void>(resolve => {
			waiting.push(resolve)
			channel.port2.postMessage(0)
		})
}

// --- Messages ---

type Method = "objects" | "media" | "locate" | "find" | "annotations"

// `s`: the session (one open document) a message belongs to.
// A password-protected file (protection.ts) is a session of its own: "protect" classifies it from reads of the
// page's bytes, "unlock" and "take" are calls on it, and an engine session opens its decrypted package with
// `doc` (no reads from the page). A Word binary document (legacy.ts) is one too: "convert" reads the page's bytes
// once (with the password to open an encrypted one, kept for that request only), the package it becomes is held,
// "take" copies it and engine sessions open it with `doc`. An RTF document (rtf.ts)
// likewise: "rtf" hands the worker a copy of the file, read into its package and held with it; "rtfProve" and "rtfWrite"
// are calls on it. An OpenDocument text document goes the same way ("rtf" with its format). A text conversion
// (convert.ts) is a session too: "textConvert" hands the worker a copy of the file and "textConverted" the result.
type ToWorker =
	| { readonly t: "open"; readonly s: number; readonly size: number; readonly options: DocxOpenOptions; readonly doc?: number }
	| { readonly t: "protect"; readonly s: number; readonly size: number }
	| { readonly t: "convert"; readonly s: number; readonly size: number; readonly password?: string }
	| { readonly t: "rtf"; readonly s: number; readonly bytes: Uint8Array; readonly format?: DocxSourceFormat }
	| {
			readonly t: "textConvert"
			readonly s: number
			readonly bytes: Uint8Array
			readonly from: TextSourceFormat
			readonly to: TextTargetFormat
			// A Word 97–2003 document's password to open, for this request only.
			readonly password?: string
	  }
	| { readonly t: "rtfProve"; readonly s: number; readonly id: number }
	| { readonly t: "rtfWrite"; readonly s: number; readonly id: number; readonly edits: DocxRtfEdits }
	| { readonly t: "rtfConvert"; readonly s: number; readonly id: number; readonly edits: DocxRtfEdits }
	| { readonly t: "unlock"; readonly s: number; readonly id: number; readonly password: string }
	| { readonly t: "take"; readonly s: number; readonly id: number }
	| { readonly t: "key"; readonly s: number; readonly id: number }
	| { readonly t: "drop"; readonly s: number }
	| { readonly t: "abort"; readonly s: number; readonly id: number }
	| { readonly t: "read"; readonly s: number; readonly id: number; readonly bytes?: Uint8Array; readonly error?: string }
	| {
			readonly t: "call"
			readonly s: number
			readonly id: number
			readonly method: Method
			readonly arg: unknown
			readonly options?: unknown
	  }
	| { readonly t: "close"; readonly s: number }

type FromWorker =
	| { readonly t: "event"; readonly s: number; readonly event: DocxEvent }
	| { readonly t: "read"; readonly s: number; readonly id: number; readonly offset: number; readonly length: number }
	| { readonly t: "result"; readonly s: number; readonly id: number; readonly value?: unknown; readonly error?: string }
	| { readonly t: "protected"; readonly s: number; readonly verdict?: DocxProtectVerdict; readonly error?: string }
	| { readonly t: "converted"; readonly s: number; readonly answer?: DocxConvertAnswer; readonly error?: string }
	| { readonly t: "rtfOpened"; readonly s: number; readonly answer?: DocxRtfOpened; readonly error?: string }
	| { readonly t: "textConverted"; readonly s: number; readonly answer?: TextConversion; readonly error?: string }
	| {
			readonly t: "rtfProved"
			readonly s: number
			readonly id: number
			readonly locked?: readonly RtfLockedBlock[]
			readonly error?: string
	  }
	| { readonly t: "rtfWritten"; readonly s: number; readonly id: number; readonly answer?: DocxRtfWritten; readonly error?: string }
	| { readonly t: "rtfConverted"; readonly s: number; readonly id: number; readonly answer?: TextConversion; readonly error?: string }
	| { readonly t: "unlocked"; readonly s: number; readonly id: number; readonly answer?: DocxUnlockAnswer; readonly error?: string }
	| {
			readonly t: "taken"
			readonly s: number
			readonly id: number
			readonly bytes?: Uint8Array
			readonly key?: OfficeKeyTransfer
			readonly error?: string
	  }

function bufferOf(bytes: ArrayBufferView): ArrayBuffer | undefined {
	return bytes.buffer instanceof ArrayBuffer ? bytes.buffer : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function findOptions(value: unknown): DocxFindOptions {
	if (!isRecord(value)) return {}

	const caseSensitive = value["caseSensitive"]
	const wholeWord = value["wholeWord"]
	const limit = value["limit"]

	return {
		...(typeof caseSensitive === "boolean" ? { caseSensitive } : {}),
		...(typeof wholeWord === "boolean" ? { wholeWord } : {}),
		...(typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? { limit } : {})
	}
}

// --- Worker side ---

// The worker's end of its channel to the page (adapt `self`).
export interface DocxWorkerScope {
	post(message: unknown, transfer: readonly ArrayBuffer[]): void
	listen(onMessage: (data: unknown) => void): void
}

interface WorkerSession {
	readonly engine: DocxEngine
	readonly reads: Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>
	nextRead: number
}

// Serves documents for the page, any number at a time, each its own engine. A closed document's engine
// drops everything it held; the worker itself lives on for the next one (and keeps fetched font files).
export function serveDocxWorker(scope: DocxWorkerScope, services: (options: DocxOpenOptions) => DocxEngineServices): void {
	const sessions = new Map<number, WorkerSession>()
	const post = (message: FromWorker, transfer: readonly ArrayBuffer[] = []): void => {
		scope.post(message, transfer)
	}
	const protection = docxProtectionServer()
	const legacy = docxLegacyServer()
	const rtf = docxRtfServer()
	const converter = docxConvertServer()
	// Reads of the page's bytes for a protected file being classified or unlocked, or a Word binary file converted.
	const protectReads = new Map<number, { reads: WorkerSession["reads"]; nextRead: number }>()
	const pageSource = (id: number, size: number, reads: { reads: WorkerSession["reads"]; nextRead: number }): ByteSource => ({
		size,
		read(offset, length) {
			if (!protectReads.has(id)) return Promise.reject(new Error("closed"))

			const read = reads.nextRead++

			return new Promise((resolve, reject) => {
				reads.reads.set(read, { resolve, reject })
				post({ t: "read", s: id, id: read, offset, length })
			})
		}
	})
	const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

	scope.listen(data => {
		if (!isRecord(data) || typeof data["s"] !== "number") return

		const message = data as ToWorker
		const id = message.s

		switch (message.t) {
			case "open": {
				if (sessions.has(id) || typeof message.size !== "number") return

				// An engine on a held document's decrypted or converted package reads it here.
				const held =
					typeof message.doc === "number"
						? (protection.plaintext(message.doc) ?? legacy.package(message.doc) ?? rtf.package(message.doc))
						: undefined

				if (typeof message.doc === "number" && held === undefined) {
					post({ t: "event", s: id, event: { type: "error", reason: "failed", message: "The document is no longer unlocked" } })

					return
				}

				const session: WorkerSession = {
					engine: new DocxEngine(
						held !== undefined
							? bytesSource(held)
							: {
									size: message.size,
									read(offset, length) {
										if (session.engine.closed) return Promise.reject(new Error("closed"))

										const read = session.nextRead++

										return new Promise((resolve, reject) => {
											session.reads.set(read, { resolve, reject })
											post({ t: "read", s: id, id: read, offset, length })
										})
									}
								},
						services(message.options),
						(event, transfer) => post({ t: "event", s: id, event }, transfer),
						message.options
					),
					reads: new Map(),
					nextRead: 1
				}

				sessions.set(id, session)
				void session.engine.run()

				break
			}
			case "protect": {
				if (protectReads.has(id) || sessions.has(id) || typeof message.size !== "number") return

				const reads = { reads: new Map() as WorkerSession["reads"], nextRead: 1 }

				protectReads.set(id, reads)
				protection.protect(id, pageSource(id, message.size, reads)).then(
					verdict => {
						if (verdict.kind !== "needsPassword") protectReads.delete(id)

						post({ t: "protected", s: id, verdict })
					},
					(error: unknown) => {
						protectReads.delete(id)
						protection.close(id)
						post({ t: "protected", s: id, error: messageOf(error) })
					}
				)

				break
			}
			case "convert": {
				if (protectReads.has(id) || sessions.has(id) || typeof message.size !== "number") return

				const reads = { reads: new Map() as WorkerSession["reads"], nextRead: 1 }

				protectReads.set(id, reads)
				legacy
					.convert(id, pageSource(id, message.size, reads), typeof message.password === "string" ? message.password : undefined)
					.then(
						answer => {
							// Converted or refused, the page's bytes are not read again.
							protectReads.delete(id)
							post({ t: "converted", s: id, answer })
						},
						(error: unknown) => {
							protectReads.delete(id)
							legacy.close(id)
							post({ t: "converted", s: id, error: messageOf(error) })
						}
					)

				break
			}
			case "rtf": {
				if (protectReads.has(id) || sessions.has(id) || !(message.bytes instanceof Uint8Array)) return

				rtf.open(id, message.bytes, message.format === "odt" ? "odt" : "rtf").then(
					answer => post({ t: "rtfOpened", s: id, answer }),
					(error: unknown) => {
						rtf.close(id)
						post({ t: "rtfOpened", s: id, error: messageOf(error) })
					}
				)

				break
			}
			case "textConvert": {
				if (protectReads.has(id) || sessions.has(id) || !(message.bytes instanceof Uint8Array)) return
				if (!TEXT_SOURCES.has(message.from) || !TEXT_TARGETS.has(message.to)) return

				const password = typeof message.password === "string" ? message.password : undefined

				converter.convert(id, message.bytes, message.from, message.to, password).then(
					answer => {
						const buffer = answer.ok ? bufferOf(answer.bytes) : undefined

						post({ t: "textConverted", s: id, answer }, buffer === undefined ? [] : [buffer])
					},
					(error: unknown) => {
						converter.close(id)
						post({ t: "textConverted", s: id, error: messageOf(error) })
					}
				)

				break
			}
			case "rtfProve": {
				const call = message.id

				// Ended by the document's close: nobody waits for an answer.
				rtf.prove(id).then(
					locked => post({ t: "rtfProved", s: id, id: call, locked }),
					(error: unknown) => {
						if (!(error instanceof RtfAborted)) post({ t: "rtfProved", s: id, id: call, error: messageOf(error) })
					}
				)

				break
			}
			case "rtfWrite": {
				const call = message.id

				rtf.write(id, message.edits).then(
					answer =>
						post(
							{ t: "rtfWritten", s: id, id: call, answer },
							answer.ok && bufferOf(answer.bytes) !== undefined ? [answer.bytes.buffer as ArrayBuffer] : []
						),
					(error: unknown) => {
						if (!(error instanceof RtfAborted)) post({ t: "rtfWritten", s: id, id: call, error: messageOf(error) })
					}
				)

				break
			}
			case "rtfConvert": {
				const call = message.id

				rtf.convertEdited(id, call, message.edits).then(
					answer => {
						const buffer = answer.ok ? bufferOf(answer.bytes) : undefined

						post({ t: "rtfConverted", s: id, id: call, answer }, buffer === undefined ? [] : [buffer])
					},
					(error: unknown) => {
						if (!(error instanceof RtfAborted)) post({ t: "rtfConverted", s: id, id: call, error: messageOf(error) })
					}
				)

				break
			}
			case "unlock": {
				const call = message.id

				protection.unlock(id, call, typeof message.password === "string" ? message.password : "").then(
					answer => {
						// The page's bytes are no longer needed once the package is decrypted.
						if (answer.ok) protectReads.delete(id)

						post({ t: "unlocked", s: id, id: call, answer })
					},
					(error: unknown) => post({ t: "unlocked", s: id, id: call, error: messageOf(error) })
				)

				break
			}
			case "take": {
				const call = message.id
				let taken: Promise<Uint8Array>

				try {
					taken =
						rtf.package(id) !== undefined
							? Promise.resolve(rtf.take(id))
							: legacy.package(id) === undefined
								? Promise.resolve(protection.take(id))
								: legacy.take(id)
				} catch (error) {
					taken = Promise.reject(error instanceof Error ? error : new Error(String(error)))
				}

				taken.then(
					bytes =>
						post({ t: "taken", s: id, id: call, bytes }, bufferOf(bytes) === undefined ? [] : [bytes.buffer as ArrayBuffer]),
					(error: unknown) => post({ t: "taken", s: id, id: call, error: messageOf(error) })
				)

				break
			}
			case "key": {
				const call = message.id

				protection.key(id, call).then(
					key => post({ t: "taken", s: id, id: call, key }),
					(error: unknown) => post({ t: "taken", s: id, id: call, error: messageOf(error) })
				)

				break
			}
			case "drop":
				protection.drop(id)

				break
			case "abort":
				protection.abort(id, message.id)
				rtf.abort(id, message.id)

				break
			case "read": {
				const session = sessions.get(id) ?? protectReads.get(id)
				const pending = session?.reads.get(message.id)

				session?.reads.delete(message.id)

				if (message.bytes instanceof Uint8Array) pending?.resolve(message.bytes)
				else pending?.reject(new RangeError(message.error ?? "Read failed"))

				break
			}
			case "call": {
				const engine = sessions.get(id)?.engine
				const call = message.id

				if (engine === undefined) {
					post({ t: "result", s: id, id: call, error: "closed" })

					return
				}

				const transfer: ArrayBuffer[] = []
				const run = async (): Promise<unknown> => {
					switch (message.method) {
						case "objects":
							return engine.objects(
								Array.isArray(message.arg) ? message.arg.filter(item => typeof item === "number") : [],
								transfer
							)
						case "media": {
							const media = typeof message.arg === "string" ? await engine.media(message.arg) : null

							if (media === null) return null

							// A view into a larger inflate buffer is copied so only its own bytes move.
							const bytes =
								media.bytes.byteOffset === 0 && media.bytes.byteLength === media.bytes.buffer.byteLength
									? media.bytes
									: media.bytes.slice()
							const buffer = bufferOf(bytes)

							if (buffer !== undefined) transfer.push(buffer)

							return { bytes, type: media.type }
						}
						case "locate":
							return typeof message.arg === "string" ? engine.locate(message.arg) : null
						case "find": {
							const matches =
								typeof message.arg === "string"
									? await engine.find(message.arg, findOptions(message.options))
									: new Int32Array(0)
							const buffer = bufferOf(matches)

							if (buffer !== undefined) transfer.push(buffer)

							return matches
						}
						case "annotations":
							return engine.annotations()
					}
				}

				run().then(
					value => post({ t: "result", s: id, id: call, value }, transfer),
					(error: unknown) =>
						post({ t: "result", s: id, id: call, error: error instanceof Error ? error.message : String(error) })
				)

				break
			}
			case "close": {
				const reads = protectReads.get(id)

				protectReads.delete(id)

				for (const pending of reads?.reads.values() ?? []) pending.reject(new Error("closed"))

				if (protection.close(id) || legacy.close(id) || rtf.close(id) || converter.close(id)) break

				const session = sessions.get(id)

				sessions.delete(id)
				session?.engine.close()

				for (const pending of session?.reads.values() ?? []) pending.reject(new Error("closed"))

				break
			}
		}
	})
}

// --- Caller side ---

// The page's end of a worker running serveDocxWorker (adapt a Worker).
export interface DocxWorkerLike {
	post(message: unknown, transfer: readonly ArrayBuffer[]): void
	listen(onMessage: (data: unknown) => void, onError: () => void): void
	terminate(): void
}

export interface DocxWorkerPool {
	readonly host: DocxHost
	// Password-protected files, unlocked and held in the worker (protection.ts).
	readonly protection: DocxProtection
	// Word binary documents, converted and held in the worker (legacy.ts).
	readonly legacy: DocxLegacy
	// RTF documents, read, held, proved and written in the worker (rtf.ts).
	readonly rtf: DocxRtf
	// OpenDocument text documents, the same way (the ODT writer).
	readonly odt: DocxRtf
	// Text documents converted to another format (convert.ts).
	readonly convert: DocxConverter
	// Starts the worker ahead of the first document (its script is parsed while the file downloads).
	prewarm(): void
	dispose(): void
}

// Timers through globalThis: the module type-checks without DOM or Node typings.
function setTimer(run: () => void, ms: number): unknown {
	const set: unknown = Reflect.get(globalThis, "setTimeout")

	return typeof set === "function" ? set(run, ms) : undefined
}

function clearTimer(handle: unknown): void {
	const clear: unknown = Reflect.get(globalThis, "clearTimeout")

	if (typeof clear === "function") clear(handle)
}

interface Connection {
	readonly worker: DocxWorkerLike
	readonly sessions: Map<number, (data: FromWorker) => void>
	readonly failures: Map<number, () => void>
	idle: unknown
}

// One worker shared by every open document and kept `idleMs` after the last one closes, so a second
// document skips the worker's start-up and font downloads. Reads are answered from each document's source
// in the caller's thread; each answer is a copy of just that range.
export function docxWorkerPool(create: () => DocxWorkerLike, idleMs = 60_000): DocxWorkerPool {
	let connection: Connection | undefined
	let nextSession = 1

	const scheduleIdle = (current: Connection): void => {
		if (current.sessions.size > 0 || current.idle !== undefined) return

		current.idle = setTimer(() => {
			current.idle = undefined

			if (current.sessions.size === 0 && connection === current) {
				connection = undefined
				current.worker.terminate()
			}
		}, idleMs)
	}

	const connect = (): Connection => {
		if (connection !== undefined) {
			if (connection.idle !== undefined) {
				clearTimer(connection.idle)
				connection.idle = undefined
			}

			return connection
		}

		const worker = create()
		const current: Connection = { worker, sessions: new Map(), failures: new Map(), idle: undefined }

		worker.listen(
			data => {
				if (isRecord(data) && typeof data["s"] === "number") current.sessions.get(data["s"])?.(data as FromWorker)
			},
			() => {
				// The worker died (a defect or out of memory): every document on it fails, the next starts a new one.
				if (connection === current) connection = undefined

				for (const fail of [...current.failures.values()]) fail()

				worker.terminate()
			}
		)
		connection = current

		return current
	}

	// `doc`: a protected file's session whose decrypted package the worker holds (the engine reads it there).
	const openSession = (source: ByteSource, listener: DocxListener, options: DocxOpenOptions, doc?: number): DocxSessionApi => {
		const current = connect()
		const id = nextSession++
		const worker = current.worker
		let closed = false
		let nextCall = 1
		let mainPartBytes: number | undefined
		const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
		const end = (): void => {
			closed = true
			current.sessions.delete(id)
			current.failures.delete(id)

			for (const call of calls.values()) call.reject(new Error("closed"))

			calls.clear()
			scheduleIdle(current)
		}
		const close = (): void => {
			if (closed) return

			worker.post({ t: "close", s: id } satisfies ToWorker, [])
			end()
		}

		current.failures.set(id, () => {
			if (closed) return

			end()
			listener({
				type: "error",
				reason: "failed",
				message: "The document worker failed",
				...(mainPartBytes === undefined ? {} : { mainPartBytes })
			})
		})
		current.sessions.set(id, message => {
			if (closed) return

			switch (message.t) {
				case "event":
					if (message.event.type === "opened") mainPartBytes = message.event.info.mainPartBytes

					listener(message.event)

					if (message.event.type === "error") close()

					break
				case "read":
					source.read(message.offset, message.length).then(
						view => {
							if (closed) return

							const copy = view.slice()

							worker.post({ t: "read", s: id, id: message.id, bytes: copy } satisfies ToWorker, [copy.buffer])
						},
						(error: unknown) => {
							if (!closed) {
								worker.post(
									{
										t: "read",
										s: id,
										id: message.id,
										error: error instanceof Error ? error.message : String(error)
									} satisfies ToWorker,
									[]
								)
							}
						}
					)

					break
				case "result": {
					const call = calls.get(message.id)

					calls.delete(message.id)

					if (message.error === undefined) call?.resolve(message.value)
					else call?.reject(new Error(message.error))

					break
				}
			}
		})
		worker.post({ t: "open", s: id, size: source.size, options, ...(doc === undefined ? {} : { doc }) } satisfies ToWorker, [])

		const call = <T>(method: Method, arg: unknown, callOptions?: unknown): Promise<T> => {
			if (closed) return Promise.reject(new Error("closed"))

			const callId = nextCall++

			return new Promise<T>((resolve, reject) => {
				calls.set(callId, { resolve: value => resolve(value as T), reject })
				worker.post({ t: "call", s: id, id: callId, method, arg, options: callOptions } satisfies ToWorker, [])
			})
		}

		return {
			objects: ids => call<readonly DocxObjectData[]>("objects", ids),
			media: partName => call<DocxMedia | null>("media", partName),
			locate: anchor => call<DocxLocation | null>("locate", anchor),
			find: (query, findOptions) => call<Int32Array>("find", query, findOptions),
			annotations: () => call<DocxAnnotations | null>("annotations", null),
			close
		}
	}
	const host: DocxHost = (source, listener, options = {}) => openSession(source, listener, options)
	const protection: DocxProtection = {
		open: (source, options = {}) => openProtected(connect, () => nextSession++, scheduleIdle, openSession, source, options)
	}

	const legacy: DocxLegacy = {
		open: (source, options = {}) => openConverted(connect, () => nextSession++, scheduleIdle, openSession, source, options)
	}
	const rtf: DocxRtf = {
		open: (bytes, options = {}) => openRtf(connect, () => nextSession++, scheduleIdle, openSession, bytes, options, "rtf")
	}
	const odt: DocxRtf = {
		open: (bytes, options = {}) => openRtf(connect, () => nextSession++, scheduleIdle, openSession, bytes, options, "odt")
	}
	const convert: DocxConverter = {
		convert: (bytes, from, to, options = {}) =>
			convertInWorker(
				connect,
				() => nextSession++,
				scheduleIdle,
				options.owned === true ? bytes : bytes.slice(),
				from,
				to,
				options.signal,
				options.password
			)
	}

	return {
		host,
		protection,
		legacy,
		rtf,
		odt,
		convert,
		prewarm() {
			scheduleIdle(connect())
		},
		dispose() {
			const current = connection

			connection = undefined

			if (current === undefined) return

			if (current.idle !== undefined) clearTimer(current.idle)

			for (const fail of [...current.failures.values()]) fail()

			current.worker.terminate()
		}
	}
}

const SIGNAL_POLL_MS = 10

// Read through a call: a check before an await would narrow the flag for the rest of the function.
function isAborted(signal: DocxAbortSignal | undefined): boolean {
	return signal?.aborted === true
}

const TEXT_SOURCES: ReadonlySet<unknown> = new Set<TextSourceFormat>(["docx", "odt", "rtf", "doc"])
const TEXT_TARGETS: ReadonlySet<unknown> = new Set<TextTargetFormat>(["docx", "odt"])

// The page's side of a text conversion in the worker: `bytes` (the caller's copy) is transferred there, the converted
// file comes back transferred. The signal closes the job (the worker ends it at its next slice); the job keeps the worker alive.
function convertInWorker(
	connect: () => Connection,
	nextId: () => number,
	scheduleIdle: (connection: Connection) => void,
	bytes: Uint8Array,
	from: TextSourceFormat,
	to: TextTargetFormat,
	signal: DocxAbortSignal | undefined,
	password: string | undefined
): Promise<DocxConversion> {
	if (signal?.aborted === true) return Promise.resolve({ kind: "aborted" })

	const current = connect()
	const id = nextId()

	return new Promise((resolve, reject) => {
		let done = false
		const finish = (answer: DocxConversion | Error): void => {
			if (done) return

			done = true
			current.sessions.delete(id)
			current.failures.delete(id)
			signal?.removeEventListener?.("abort", abort)
			scheduleIdle(current)

			if (answer instanceof Error) reject(answer)
			else resolve(answer)
		}
		const abort = (): void => {
			if (done) return

			current.worker.post({ t: "close", s: id } satisfies ToWorker, [])
			finish({ kind: "aborted" })
		}

		current.failures.set(id, () => {
			finish(new Error("The document worker failed"))
		})
		current.sessions.set(id, message => {
			if (message.t !== "textConverted") return

			if (message.answer === undefined) finish(new Error(message.error ?? "The conversion failed"))
			else finish(signal?.aborted === true ? { kind: "aborted" } : answerOf(message.answer))
		})
		signal?.addEventListener?.("abort", abort)
		const buffer = bufferOf(bytes)

		current.worker.post(
			{ t: "textConvert", s: id, bytes, from, to, ...(password === undefined ? {} : { password }) } satisfies ToWorker,
			buffer === undefined ? [] : [buffer]
		)
	})
}

// The page's side of a protected file in the worker: reads of `source` answered while it is classified and
// unlocked, then calls on the held document. Its session keeps the worker alive until released.
function openProtected(
	connect: () => Connection,
	nextId: () => number,
	scheduleIdle: (connection: Connection) => void,
	openSession: (source: ByteSource, listener: DocxListener, options: DocxOpenOptions, doc?: number) => DocxSessionApi,
	source: ByteSource,
	options: DocxProtectionOptions
): Promise<DocxProtectedOpen> {
	if (options.signal?.aborted === true) return Promise.resolve({ kind: "aborted" })

	const current = connect()
	const id = nextId()
	const worker = current.worker
	let closed = false
	let nextCall = 1
	let probed: { resolve: (verdict: DocxProtectVerdict) => void; reject: (error: Error) => void } | undefined
	const calls = new Map<number, { resolve: (message: FromWorker) => void; reject: (error: Error) => void }>()
	const end = (error: Error): void => {
		if (closed) return

		closed = true
		current.sessions.delete(id)
		current.failures.delete(id)
		probed?.reject(error)

		for (const pending of calls.values()) pending.reject(error)

		calls.clear()
		scheduleIdle(current)
	}
	const close = (): void => {
		if (closed) return

		worker.post({ t: "close", s: id } satisfies ToWorker, [])
		end(new Error("closed"))
	}
	// One call on the held document; an abort of `signal` asks the worker to stop it.
	// One call on the held document; an abort of `signal` asks the worker to stop it (a signal without events is
	// looked at every SIGNAL_POLL_MS).
	const call = (message: (callId: number) => ToWorker, signal: DocxProtectionOptions["signal"]): Promise<FromWorker> => {
		if (closed) return Promise.reject(new Error("closed"))

		const callId = nextCall++
		let stopped = false
		let poll: unknown
		const stop = (): void => {
			if (stopped || closed) return

			stopped = true
			worker.post({ t: "abort", s: id, id: callId } satisfies ToWorker, [])
		}
		const look = (): void => {
			poll = undefined

			if (signal?.aborted === true) stop()
			else if (!stopped && calls.has(callId)) poll = setTimer(look, SIGNAL_POLL_MS)
		}

		if (signal?.addEventListener !== undefined) signal.addEventListener("abort", stop)

		return new Promise<FromWorker>((resolve, reject) => {
			calls.set(callId, { resolve, reject })
			worker.post(message(callId), [])

			if (signal?.aborted === true) stop()
			else if (signal !== undefined && signal.addEventListener === undefined) poll = setTimer(look, SIGNAL_POLL_MS)
		}).finally(() => {
			signal?.removeEventListener?.("abort", stop)

			if (poll !== undefined) clearTimer(poll)
		})
	}

	current.failures.set(id, () => end(new Error("The document worker failed")))
	current.sessions.set(id, message => {
		if (closed) return

		switch (message.t) {
			case "read":
				source.read(message.offset, message.length).then(
					view => {
						if (closed) return

						const copy = view.slice()

						worker.post({ t: "read", s: id, id: message.id, bytes: copy } satisfies ToWorker, [copy.buffer])
					},
					(error: unknown) => {
						if (!closed)
							worker.post(
								{
									t: "read",
									s: id,
									id: message.id,
									error: error instanceof Error ? error.message : String(error)
								} satisfies ToWorker,
								[]
							)
					}
				)

				break
			case "protected":
				if (message.verdict === undefined) probed?.reject(new Error(message.error ?? "The protection check failed"))
				else probed?.resolve(message.verdict)

				probed = undefined

				break
			case "unlocked":
			case "taken": {
				const pending = calls.get(message.id)

				calls.delete(message.id)
				pending?.resolve(message)

				break
			}
		}
	})

	const abortProbe = (): void => close()

	options.signal?.addEventListener?.("abort", abortProbe)

	return new Promise<DocxProtectVerdict>((resolve, reject) => {
		probed = { resolve, reject }
		worker.post({ t: "protect", s: id, size: source.size } satisfies ToWorker, [])
	})
		.finally(() => options.signal?.removeEventListener?.("abort", abortProbe))
		.then(
			verdict => {
				if (verdict.kind !== "needsPassword" || options.signal?.aborted === true) {
					close()

					return verdict.kind === "needsPassword" ? { kind: "aborted" } : verdict
				}

				let unlocked = false

				return {
					kind: "needsPassword",
					locked: {
						scheme: verdict.scheme,
						spinCount: verdict.spinCount,
						async unlock(password, unlockOptions = {}): Promise<DocxDocumentUnlock> {
							if (unlocked) return { ok: false, reason: "aborted" }

							const reply = await call(callId => ({ t: "unlock", s: id, id: callId, password }), unlockOptions.signal)

							if (reply.t !== "unlocked" || reply.answer === undefined)
								throw new Error(reply.t === "unlocked" ? (reply.error ?? "Unlock failed") : "Unlock failed")

							const answer = reply.answer

							if (!answer.ok) return answer

							unlocked = true

							return {
								ok: true,
								document: {
									scheme: answer.scheme,
									integrity: answer.integrity,
									bytes: heldSource(answer.size),
									host: (held, listener, openOptions = {}) => openSession(held, listener, openOptions, id),
									async take(takeOptions = {}) {
										const taken = await call(callId => ({ t: "take", s: id, id: callId }), takeOptions.signal)

										if (taken.t !== "taken" || taken.bytes === undefined)
											throw new Error(
												taken.t === "taken"
													? (taken.error ?? "The document could not be taken")
													: "The document could not be taken"
											)

										return {
											bytes: taken.bytes,
											async key(keyOptions = {}) {
												const reply = await call(callId => ({ t: "key", s: id, id: callId }), keyOptions.signal)

												if (reply.t !== "taken" || reply.key === undefined)
													throw new Error(
														reply.t === "taken"
															? (reply.error ?? "The key could not be taken")
															: "The key could not be taken"
													)

												return reply.key
											}
										}
									},
									dropPackage() {
										if (!closed) worker.post({ t: "drop", s: id } satisfies ToWorker, [])
									},
									release: close
								}
							}
						},
						dispose: close
					}
				}
			},
			(error: unknown) => {
				close()

				if (options.signal?.aborted === true) return { kind: "aborted" }

				throw error
			}
		)
}

// The page's side of a Word binary document converted in the worker: reads of `source` answered while it converts,
// then the held package (opened by engine sessions, copied by take()) until released.
function openConverted(
	connect: () => Connection,
	nextId: () => number,
	scheduleIdle: (connection: Connection) => void,
	openSession: (source: ByteSource, listener: DocxListener, options: DocxOpenOptions, doc?: number) => DocxSessionApi,
	source: ByteSource,
	options: DocxLegacyOptions
): Promise<DocxLegacyOpen> {
	if (options.signal?.aborted === true) return Promise.resolve({ kind: "aborted" })

	const current = connect()
	const id = nextId()
	const worker = current.worker
	let closed = false
	let nextCall = 1
	let converting: { resolve: (answer: DocxConvertAnswer) => void; reject: (error: Error) => void } | undefined
	const takes = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>()
	const end = (error: Error): void => {
		if (closed) return

		closed = true
		current.sessions.delete(id)
		current.failures.delete(id)
		converting?.reject(error)

		for (const pending of takes.values()) pending.reject(error)

		takes.clear()
		scheduleIdle(current)
	}
	const close = (): void => {
		if (closed) return

		worker.post({ t: "close", s: id } satisfies ToWorker, [])
		end(new Error("closed"))
	}

	current.failures.set(id, () => end(new Error("The document worker failed")))
	current.sessions.set(id, message => {
		if (closed) return

		switch (message.t) {
			case "read":
				source.read(message.offset, message.length).then(
					view => {
						if (closed) return

						const copy = view.slice()

						worker.post({ t: "read", s: id, id: message.id, bytes: copy } satisfies ToWorker, [copy.buffer])
					},
					(error: unknown) => {
						if (!closed)
							worker.post(
								{
									t: "read",
									s: id,
									id: message.id,
									error: error instanceof Error ? error.message : String(error)
								} satisfies ToWorker,
								[]
							)
					}
				)

				break
			case "converted":
				if (message.answer === undefined) converting?.reject(new Error(message.error ?? "The conversion failed"))
				else converting?.resolve(message.answer)

				converting = undefined

				break
			case "taken": {
				const pending = takes.get(message.id)

				takes.delete(message.id)

				if (message.bytes === undefined) pending?.reject(new Error(message.error ?? "The document could not be taken"))
				else pending?.resolve(message.bytes)

				break
			}
		}
	})

	const abort = (): void => close()

	options.signal?.addEventListener?.("abort", abort)

	return new Promise<DocxConvertAnswer>((resolve, reject) => {
		converting = { resolve, reject }
		worker.post(
			{
				t: "convert",
				s: id,
				size: source.size,
				...(options.password === undefined ? {} : { password: options.password })
			} satisfies ToWorker,
			[]
		)
	})
		.finally(() => options.signal?.removeEventListener?.("abort", abort))
		.then(
			(answer): DocxLegacyOpen => {
				if (!answer.ok || options.signal?.aborted === true) {
					close()

					return answer.ok ? { kind: "aborted" } : { kind: "refused", refusal: answer.refusal }
				}

				return {
					kind: "converted",
					document: {
						host: (held, listener, openOptions = {}) => openSession(held, listener, openOptions, id),
						bytes: heldSource(answer.size),
						notConverted: answer.notConverted,
						decrypted: answer.decrypted,
						take(takeOptions = {}) {
							if (closed) return Promise.reject(new Error("closed"))
							if (takeOptions.signal?.aborted === true) return Promise.reject(new Error("Aborted"))

							const callId = nextCall++

							return new Promise<Uint8Array>((resolve, reject) => {
								takes.set(callId, { resolve, reject })
								worker.post({ t: "take", s: id, id: callId } satisfies ToWorker, [])
							})
						},
						release: close
					}
				}
			},
			(error: unknown): DocxLegacyOpen => {
				close()

				if (options.signal?.aborted === true) return { kind: "aborted" }

				throw error
			}
		)
}

// The page's side of an RTF (or OpenDocument text) document read in the worker: the file handed over once, then the
// held package (opened by engine sessions, copied by take()), proofs and writes as calls on it, until released.
function openRtf(
	connect: () => Connection,
	nextId: () => number,
	scheduleIdle: (connection: Connection) => void,
	openSession: (source: ByteSource, listener: DocxListener, options: DocxOpenOptions, doc?: number) => DocxSessionApi,
	bytes: Uint8Array,
	options: DocxProtectionOptions,
	format: DocxSourceFormat
): Promise<DocxRtfOpen> {
	if (options.signal?.aborted === true) return Promise.resolve({ kind: "aborted" })

	const current = connect()
	const id = nextId()
	const worker = current.worker
	let closed = false
	let nextCall = 1
	let opening: { resolve: (answer: DocxRtfOpened) => void; reject: (error: Error) => void } | undefined
	const calls = new Map<number, { resolve: (value: FromWorker) => void; reject: (error: Error) => void }>()
	const end = (error: Error): void => {
		if (closed) return

		closed = true
		current.sessions.delete(id)
		current.failures.delete(id)
		opening?.reject(error)

		for (const pending of calls.values()) pending.reject(error)

		calls.clear()
		scheduleIdle(current)
	}
	const close = (): void => {
		if (closed) return

		worker.post({ t: "close", s: id } satisfies ToWorker, [])
		end(new Error("closed"))
	}
	const call = (message: (callId: number) => ToWorker, transfer: readonly ArrayBuffer[] = []): Promise<FromWorker> => {
		if (closed) return Promise.reject(new Error("closed"))

		const callId = nextCall++

		return new Promise<FromWorker>((resolve, reject) => {
			calls.set(callId, { resolve, reject })
			worker.post(message(callId), transfer)
		})
	}

	current.failures.set(id, () => end(new Error("The document worker failed")))
	current.sessions.set(id, message => {
		if (closed) return

		if (message.t === "rtfOpened") {
			if (message.answer === undefined) opening?.reject(new Error(message.error ?? "The document could not be read"))
			else opening?.resolve(message.answer)

			opening = undefined

			return
		}

		if (message.t === "taken" || message.t === "rtfProved" || message.t === "rtfWritten" || message.t === "rtfConverted") {
			const pending = calls.get(message.id)

			calls.delete(message.id)
			pending?.resolve(message)
		}
	})

	const abort = (): void => close()

	options.signal?.addEventListener?.("abort", abort)

	// The file goes as a copy: the page's buffer stays with the preview cache.
	const copy = bytes.slice()

	return new Promise<DocxRtfOpened>((resolve, reject) => {
		opening = { resolve, reject }
		worker.post({ t: "rtf", s: id, bytes: copy, ...(format === "odt" ? { format } : {}) } satisfies ToWorker, [copy.buffer])
	})
		.finally(() => options.signal?.removeEventListener?.("abort", abort))
		.then(
			(answer): DocxRtfOpen => {
				if (!answer.ok || options.signal?.aborted === true) {
					close()

					return answer.ok || !answer.notRtf ? { kind: "aborted" } : { kind: "notRtf" }
				}

				return {
					kind: "opened",
					document: {
						host: (held, listener, openOptions = {}) => openSession(held, listener, openOptions, id),
						bytes: heldSource(answer.size),
						untranslated: answer.untranslated,
						async take() {
							const reply = await call(callId => ({ t: "take", s: id, id: callId }))

							if (reply.t !== "taken" || reply.bytes === undefined)
								throw new Error(reply.t === "taken" ? (reply.error ?? "") : "The document could not be taken")

							return reply.bytes
						},
						async prove() {
							const reply = await call(callId => ({ t: "rtfProve", s: id, id: callId }))

							if (reply.t !== "rtfProved" || reply.locked === undefined)
								throw new Error(reply.t === "rtfProved" ? (reply.error ?? "") : "The document could not be proved")

							return reply.locked
						},
						async write(edits) {
							const parts = edits.parts.map(([name, part]) => [name, part.slice()] as const)
							const reply = await call(
								callId => ({ t: "rtfWrite", s: id, id: callId, edits: { parts, removed: edits.removed } }),
								parts.map(([, part]) => part.buffer as ArrayBuffer)
							)

							if (reply.t !== "rtfWritten" || reply.answer === undefined)
								throw new Error(reply.t === "rtfWritten" ? (reply.error ?? "") : "The document could not be written")
							if (!reply.answer.ok) throw new DocxRtfRefusal(reply.answer.reason, reply.answer.message)

							return {
								bytes: reply.answer.bytes,
								...(reply.answer.notices === undefined ? {} : { notices: reply.answer.notices })
							}
						},
						async convertEdited(edits, convertOptions = {}) {
							const signal = convertOptions.signal

							if (signal?.aborted === true) return { kind: "aborted" }

							const parts = edits.parts.map(([name, part]) => [name, part.slice()] as const)
							let callId = 0
							let onAbort: (() => void) | undefined
							const aborted = new Promise<"aborted">(resolve => {
								onAbort = () => {
									if (!closed) worker.post({ t: "abort", s: id, id: callId } satisfies ToWorker, [])

									resolve("aborted")
								}
								signal?.addEventListener?.("abort", onAbort)
							})

							try {
								const reply = await Promise.race([
									call(
										next => {
											callId = next

											return { t: "rtfConvert", s: id, id: next, edits: { parts, removed: edits.removed } }
										},
										parts.map(([, part]) => part.buffer as ArrayBuffer)
									),
									aborted
								])

								if (reply === "aborted" || isAborted(signal)) return { kind: "aborted" }
								if (reply.t !== "rtfConverted" || reply.answer === undefined)
									throw new Error(
										reply.t === "rtfConverted" ? (reply.error ?? "") : "The document could not be converted"
									)

								return answerOf(reply.answer)
							} finally {
								if (onAbort !== undefined) signal?.removeEventListener?.("abort", onAbort)
							}
						},
						release: close
					}
				}
			},
			(error: unknown): DocxRtfOpen => {
				close()

				if (options.signal?.aborted === true) return { kind: "aborted" }

				throw error
			}
		)
}

// A host that runs the engine on the calling thread, yielding between slices. `services` is called per
// document (a fresh font manager scope and measurer state per document is the engine's own business).
export function inThreadDocxHost(services: (options: DocxOpenOptions) => DocxEngineServices): DocxHost {
	return (source, listener, options = {}) => {
		let closed = false
		const engine = new DocxEngine(
			source,
			services(options),
			event => {
				if (!closed) listener(event)
			},
			options
		)

		void engine.run()

		return {
			objects: ids => engine.objects(ids),
			media: partName => engine.media(partName),
			locate: anchor => engine.locate(anchor),
			find: (query, findOptions) => engine.find(query, findOptions),
			annotations: () => engine.annotations(),
			close() {
				closed = true
				engine.close()
			}
		}
	}
}
