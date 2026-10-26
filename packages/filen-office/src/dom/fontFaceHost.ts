import type { FontFaceDescriptor, FontHost } from "../core/fonts/index"

// FontHost over the CSS Font Loading API, for a window (`{ FontFace, fonts: document.fonts }`) or a worker
// (`self`). Fonts load from bytes or local(): the apps' `font-src 'self'` blocks blob: and data: URLs, and
// bytes need no fetch from a WebView's file:// origin. The shapes are declared here so the package needs
// no DOM typings; the platform objects satisfy them.

interface FontFaceLike {
	load(): Promise<unknown>
}

export interface FontFaceScope {
	readonly FontFace: new (family: string, source: string | ArrayBuffer, descriptors: { weight: string; style: string }) => FontFaceLike
	readonly fonts: {
		add(face: FontFaceLike): unknown
		delete(face: FontFaceLike): unknown
	}
}

function descriptors(face: FontFaceDescriptor): { weight: string; style: string } {
	return {
		weight: typeof face.weight === "number" ? String(face.weight) : `${face.weight[0]} ${face.weight[1]}`,
		style: face.italic ? "italic" : "normal"
	}
}

// The platform copies font data, so a view over a larger buffer is sliced only when it has to be.
function arrayBufferOf(data: Uint8Array): ArrayBuffer {
	const buffer = data.buffer

	if (buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === buffer.byteLength) return buffer

	return data.slice().buffer
}

// A CSS string for local(): the name comes from a document, so quotes, backslashes and control
// characters cannot be allowed to end the string or the descriptor.
export function localSource(name: string): string {
	let escaped = ""

	for (const char of name) {
		const code = char.charCodeAt(0)

		if (code < 0x20 || code === 0x7f) continue

		escaped += char === '"' || char === "\\" ? `\\${char}` : char
	}

	return `local("${escaped}")`
}

// How long a local() lookup may take before the font counts as not installed: a lookup that never settles must not
// hold up the text waiting on it.
export const LOCAL_FONT_TIMEOUT_MS = 3000

// Faces whose load has not settled. Firefox's workers collect a FontFace that only its own pending load refers to,
// and that load then never settles; holding each one here until it does keeps it alive.
const loading = new Set<FontFaceLike>()

// Timers through globalThis: the module type-checks without DOM or Node typings.
function setTimer(run: () => void, ms: number): unknown {
	const set: unknown = Reflect.get(globalThis, "setTimeout")

	return typeof set === "function" ? Reflect.apply(set, globalThis, [run, ms]) : undefined
}

function clearTimer(handle: unknown): void {
	const clear: unknown = Reflect.get(globalThis, "clearTimeout")

	if (typeof clear === "function") Reflect.apply(clear, globalThis, [handle])
}

async function load(fontFace: FontFaceLike, timeoutMs: number | undefined): Promise<void> {
	loading.add(fontFace)

	let timer: unknown

	try {
		await (timeoutMs === undefined
			? fontFace.load()
			: Promise.race([
					fontFace.load(),
					new Promise((_, reject) => {
						timer = setTimer(() => {
							reject(new Error("local font lookup timed out"))
						}, timeoutMs)
					})
				]))
	} finally {
		if (timer !== undefined) clearTimer(timer)

		loading.delete(fontFace)
	}
}

export function fontFaceHost(scope: FontFaceScope): FontHost {
	const faces = new Map<string, FontFaceLike[]>()
	// Families removed while one of their faces was still loading: that face must not be added after.
	const removed = new Set<string>()

	const add = async (face: FontFaceDescriptor, source: string | ArrayBuffer, timeoutMs?: number): Promise<boolean> => {
		let fontFace: FontFaceLike

		try {
			fontFace = new scope.FontFace(face.family, source, descriptors(face))
			await load(fontFace, timeoutMs)
		} catch {
			return false
		}

		if (removed.has(face.family)) return false

		scope.fonts.add(fontFace)

		const list = faces.get(face.family)

		if (list === undefined) faces.set(face.family, [fontFace])
		else list.push(fontFace)

		return true
	}

	return {
		addBytes: (face, data) => add(face, arrayBufferOf(data)),
		addLocal: (face, name) => add(face, localSource(name), LOCAL_FONT_TIMEOUT_MS),
		remove(family) {
			for (const face of faces.get(family) ?? []) scope.fonts.delete(face)

			faces.delete(family)
			// Aliases are never reused, so the set only grows by the families a document used.
			removed.add(family)
		}
	}
}
