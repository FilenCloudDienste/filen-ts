import type { Page } from "@playwright/test"

// What the page hands its SourceBuffers, recorded from the page's start (an init script): each buffer's MIME type, the
// first bytes appended to it, and every error and abort event it fires. The remux worker's output is what is
// appended, so its samples' decode and presentation times can be read back from it (fmp4Samples).

export interface MseRecord {
	buffers: { mime: string; bytes: string; appends: number; appendedBytes: number }[]
	events: { buffer: number; type: string; at: number }[]
}

// Bytes kept per buffer: enough for the init segment and the first fragments.
const KEPT_BYTES = 2 * 1024 * 1024

export async function recordMse(page: Page): Promise<void> {
	await page.addInitScript(
		({ kept }) => {
			interface Log {
				buffers: { mime: string; chunks: Uint8Array[]; kept: number; appends: number; appendedBytes: number }[]
				events: { buffer: number; type: string; at: number }[]
				ids: WeakMap<SourceBuffer, number>
			}

			const log: Log = { buffers: [], events: [], ids: new WeakMap() }

			Object.assign(window, { __mseRecord: log })

			const wrapAdd = (proto: { addSourceBuffer(type: string): SourceBuffer } | undefined): void => {
				if (proto === undefined) {
					return
				}

				// Taken off the prototype as it stands, to call on each MediaSource in turn.
				const add = Object.getOwnPropertyDescriptor(proto, "addSourceBuffer")?.value as (
					this: unknown,
					type: string
				) => SourceBuffer

				proto.addSourceBuffer = function (this: unknown, type: string): SourceBuffer {
					const buffer = add.call(this, type)
					const id = log.buffers.push({ mime: type, chunks: [], kept: 0, appends: 0, appendedBytes: 0 }) - 1

					log.ids.set(buffer, id)

					for (const type of ["error", "abort"]) {
						buffer.addEventListener(type, () => {
							log.events.push({ buffer: id, type, at: performance.now() })
						})
					}

					return buffer
				}
			}

			wrapAdd((globalThis as { MediaSource?: { prototype: { addSourceBuffer(type: string): SourceBuffer } } }).MediaSource?.prototype)
			wrapAdd(
				(globalThis as { ManagedMediaSource?: { prototype: { addSourceBuffer(type: string): SourceBuffer } } }).ManagedMediaSource
					?.prototype
			)

			const append = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, "appendBuffer")?.value as (
				this: SourceBuffer,
				data: BufferSource
			) => void

			SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource): void {
				const id = log.ids.get(this)
				const entry = id === undefined ? undefined : log.buffers[id]

				if (entry !== undefined) {
					const bytes = ArrayBuffer.isView(data)
						? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
						: new Uint8Array(data)

					entry.appends++
					entry.appendedBytes += bytes.byteLength

					if (entry.kept < kept) {
						entry.chunks.push(bytes.slice(0, kept - entry.kept))
						entry.kept += Math.min(bytes.byteLength, kept - entry.kept)
					}
				}

				append.call(this, data)
			}
		},
		{ kept: KEPT_BYTES }
	)
}

// Starts the record over, for the next file.
export async function resetMse(page: Page): Promise<void> {
	await page.evaluate(() => {
		const log = (window as unknown as { __mseRecord?: { buffers: unknown[]; events: unknown[] } }).__mseRecord

		if (log !== undefined) {
			log.buffers.length = 0
			log.events.length = 0
		}
	})
}

export async function readMse(page: Page): Promise<MseRecord> {
	return page.evaluate(() => {
		const log = (
			window as unknown as {
				__mseRecord?: {
					buffers: { mime: string; chunks: Uint8Array[]; appends: number; appendedBytes: number }[]
					events: { buffer: number; type: string; at: number }[]
				}
			}
		).__mseRecord

		const base64 = (chunks: Uint8Array[]): string => {
			let binary = ""

			for (const chunk of chunks) {
				for (let at = 0; at < chunk.length; at += 0x8000) {
					binary += String.fromCharCode(...chunk.subarray(at, at + 0x8000))
				}
			}

			return btoa(binary)
		}

		return {
			buffers: (log?.buffers ?? []).map(buffer => ({
				mime: buffer.mime,
				bytes: base64(buffer.chunks),
				appends: buffer.appends,
				appendedBytes: buffer.appendedBytes
			})),
			events: [...(log?.events ?? [])]
		}
	})
}
