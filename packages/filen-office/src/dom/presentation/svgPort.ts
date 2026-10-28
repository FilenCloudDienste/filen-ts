import { prepareSvgThumb } from "@filen/shared/svgThumb"
import type { BitmapLike } from "./protocol"

// SVG pictures, rasterised on the page for a worker (presentation or jobs): workers cannot decode SVG
// (createImageBitmap takes none there), so the page gives each worker a port of its own, posted outside the protocol
// (it carries no session), and draws each SVG it is sent through an <img>, whose secure mode runs no script, fires
// no handler and fetches nothing. prepareSvgThumb refuses what that mode does not cover (an entity bomb in the
// DOCTYPE) and stamps the size asked on the root, so every engine draws the vector at that size, crisply (Firefox
// draws one without a size of its own not at all).

export interface SvgPortMessage {
	readonly t: "svgPort"
	readonly port: unknown
}

export type SvgRasterizer = (bytes: Uint8Array, maxSide: number) => Promise<BitmapLike | undefined>

interface RasterPort {
	onmessage: ((event: { readonly data: unknown }) => void) | null
	postMessage(message: unknown, transfer?: unknown[]): void
	close?(): void
}

// The largest SVG a page decodes for a worker, and the longest side it draws.
export const MAX_SVG_BYTES = 16 * 1024 * 1024
export const MAX_SVG_SIDE = 4096
// How long a worker waits for the page's raster.
const SVG_TIMEOUT_MS = 10_000

// Timers through globalThis: the module type-checks without DOM or Node typings.
export function setTimer(run: () => void, ms: number): unknown {
	const set: unknown = Reflect.get(globalThis, "setTimeout")

	return typeof set === "function" ? Reflect.apply(set, globalThis, [run, ms]) : undefined
}

export function clearTimer(handle: unknown): void {
	const clear: unknown = Reflect.get(globalThis, "clearTimeout")

	if (typeof clear === "function") Reflect.apply(clear, globalThis, [handle])
}

export function isBitmap(value: unknown): value is BitmapLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { close?: unknown }).close === "function" &&
		typeof (value as { width?: unknown }).width === "number"
	)
}

function isSvgPort(data: unknown): data is SvgPortMessage {
	return (
		typeof data === "object" && data !== null && (data as { t?: unknown }).t === "svgPort" && (data as { s?: unknown }).s === undefined
	)
}

function isPort(value: unknown): value is RasterPort {
	return typeof value === "object" && value !== null && typeof (value as { postMessage?: unknown }).postMessage === "function"
}

// The worker's end: asks the page over the port it posted, once it arrives (undefined before, or without one).
export function workerSvgRasterizer(scope: {
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void
}): { readonly rasterize: SvgRasterizer; stop(): void } {
	let port: RasterPort | undefined
	let next = 1
	const waiting = new Map<number, (bitmap: BitmapLike | undefined) => void>()
	const listener = (event: { readonly data: unknown }): void => {
		if (!isSvgPort(event.data) || !isPort(event.data.port)) return

		port?.close?.()
		port = event.data.port
		port.onmessage = answer => {
			const data = answer.data as { readonly id?: unknown; readonly bitmap?: unknown }
			const resolve = typeof data.id === "number" ? waiting.get(data.id) : undefined

			if (resolve === undefined) {
				if (isBitmap(data.bitmap)) data.bitmap.close()

				return
			}

			waiting.delete(data.id as number)
			resolve(isBitmap(data.bitmap) ? data.bitmap : undefined)
		}
	}

	scope.addEventListener("message", listener)

	return {
		rasterize(bytes, maxSide) {
			const target = port

			if (target === undefined || bytes.length > MAX_SVG_BYTES) return Promise.resolve(undefined)

			const id = next++
			const copy = bytes.slice()

			return new Promise(resolve => {
				const timer = setTimer(() => {
					waiting.delete(id)
					resolve(undefined)
				}, SVG_TIMEOUT_MS)

				waiting.set(id, bitmap => {
					clearTimer(timer)
					resolve(bitmap)
				})
				target.postMessage({ id, bytes: copy, maxSide: Math.min(MAX_SVG_SIDE, Math.max(1, Math.ceil(maxSide))) }, [copy.buffer])
			})
		},
		stop() {
			scope.removeEventListener("message", listener)
			port?.close?.()

			for (const resolve of waiting.values()) resolve(undefined)

			waiting.clear()
		}
	}
}

// The page's end: an SVG drawn by an <img> on a canvas at most `maxSide` on its longer side, in its own proportions
// (its viewBox's, else its width and height's). Undefined in a realm without images (a worker, Node).
export function pageSvgRasterizer(scope: unknown): SvgRasterizer | undefined {
	const Image: unknown = Reflect.get(scope as object, "Image")
	const URL: unknown = Reflect.get(scope as object, "URL")
	const Blob: unknown = Reflect.get(scope as object, "Blob")
	const Offscreen: unknown = Reflect.get(scope as object, "OffscreenCanvas")
	const Decoder: unknown = Reflect.get(scope as object, "TextDecoder")

	if (
		typeof Image !== "function" ||
		typeof URL !== "function" ||
		typeof Blob !== "function" ||
		typeof Offscreen !== "function" ||
		typeof Decoder !== "function"
	)
		return undefined

	const urls = URL as unknown as { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void }
	const decoder = new (Decoder as new () => { decode(bytes: Uint8Array): string })()

	return async (bytes, maxSide) => {
		if (bytes.length > MAX_SVG_BYTES) return undefined

		const prepared = prepareSvgThumb(decoder.decode(bytes), Math.min(MAX_SVG_SIDE, Math.max(1, Math.ceil(maxSide))))

		if (prepared.type === "rejected") return undefined

		const url = urls.createObjectURL(
			new (Blob as new (parts: unknown[], options: { type: string }) => unknown)([prepared.markup], { type: "image/svg+xml" })
		)

		try {
			const image = new (Image as new (width: number, height: number) => { src: string; decode(): Promise<void> })(
				prepared.width,
				prepared.height
			)

			image.src = url
			await image.decode()

			const canvas = new (
				Offscreen as new (
					width: number,
					height: number
				) => {
					getContext(kind: "2d"): { drawImage(image: unknown, x: number, y: number, w: number, h: number): void } | null
					transferToImageBitmap(): BitmapLike
				}
			)(prepared.width, prepared.height)
			const context = canvas.getContext("2d")

			if (context === null) return undefined

			context.drawImage(image, 0, 0, prepared.width, prepared.height)

			return canvas.transferToImageBitmap()
		} catch {
			return undefined
		} finally {
			urls.revokeObjectURL(url)
		}
	}
}

// Serves a worker's SVG rasters on the page with `rasterize`: one channel per worker, its far end posted to the
// worker. Returns what closes it; undefined where the page cannot rasterise.
export function offerSvgPort(
	worker: { postMessage(message: SvgPortMessage, transfer: unknown[]): void },
	rasterize: SvgRasterizer | undefined = pageSvgRasterizer(globalThis)
): (() => void) | undefined {
	const Channel: unknown = Reflect.get(globalThis, "MessageChannel")

	if (rasterize === undefined || typeof Channel !== "function") return undefined

	const channel = new (Channel as new () => { readonly port1: RasterPort; readonly port2: RasterPort })()

	channel.port1.onmessage = event => {
		const request = event.data as { readonly id?: unknown; readonly bytes?: unknown; readonly maxSide?: unknown }

		if (typeof request.id !== "number" || !(request.bytes instanceof Uint8Array) || typeof request.maxSide !== "number") return

		void rasterize(request.bytes, request.maxSide).then(bitmap => {
			channel.port1.postMessage({ id: request.id, bitmap: bitmap ?? null }, bitmap === undefined ? [] : [bitmap])
		})
	}
	worker.postMessage({ t: "svgPort", port: channel.port2 }, [channel.port2])

	return () => channel.port1.close?.()
}
