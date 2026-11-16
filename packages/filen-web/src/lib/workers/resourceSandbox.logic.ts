// The resource sandbox's pure parts: which class a requested URL falls in, data: decoding under a byte cap, and the byte
// budget every served resource counts against.

export type ResourceRequest =
	| { kind: "blob"; href: string }
	| { kind: "data"; href: string }
	// The path after `filen-ref:///`, still percent-encoded; the resolver decodes and normalises it.
	| { kind: "ref"; path: string }
	| { kind: "asset"; href: string }
	| { kind: "external" }

export const REFERENCE_SCHEME = "filen-ref:"

// `assets` are same-origin path prefixes ("/assets/three/"); anything else on any origin is external.
export function classifyResourceUrl(raw: string, base: string, assets: readonly string[]): ResourceRequest {
	let url: URL

	try {
		url = new URL(raw, base)
	} catch {
		return { kind: "external" }
	}

	switch (url.protocol) {
		case "blob:": {
			return { kind: "blob", href: url.href }
		}

		case "data:": {
			return { kind: "data", href: url.href }
		}

		case REFERENCE_SCHEME: {
			return { kind: "ref", path: url.pathname.replace(/^\/+/, "") }
		}

		case "http:":
		case "https:": {
			const sameOrigin = url.origin === new URL(base).origin

			return sameOrigin && assets.some(prefix => url.pathname.startsWith(prefix))
				? { kind: "asset", href: url.href }
				: { kind: "external" }
		}

		default: {
			return { kind: "external" }
		}
	}
}

export type DataUrlResult =
	{ status: "ok"; bytes: Uint8Array<ArrayBuffer>; type: string } | { status: "overBudget" } | { status: "malformed" }

const PERCENT = 0x25

function hexValue(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) {
		return byte - 0x30
	}

	const lower = byte | 0x20

	return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1
}

// Decoded in place over the UTF-8 of the body: a percent triple becomes its byte, anything else stays as is.
function percentDecode(body: string): Uint8Array<ArrayBuffer> {
	const encoded = new TextEncoder().encode(body)
	let length = 0

	for (let index = 0; index < encoded.length; index++) {
		const byte = encoded[index] ?? 0
		const high = byte === PERCENT ? hexValue(encoded[index + 1] ?? 0) : -1
		const low = high >= 0 ? hexValue(encoded[index + 2] ?? 0) : -1

		if (low >= 0) {
			encoded[length++] = (high << 4) | low
			index += 2
		} else {
			encoded[length++] = byte
		}
	}

	return encoded.slice(0, length)
}

function base64Decode(body: string): Uint8Array<ArrayBuffer> | null {
	let binary: string

	try {
		binary = atob(body.replace(/\s+/g, ""))
	} catch {
		return null
	}

	const bytes = new Uint8Array(binary.length)

	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}

	return bytes
}

// The decoded size is bounded before anything is decoded: base64 by its length, percent-encoding by its UTF-8 length
// (decoding only shrinks it).
export function decodeDataUrl(href: string, limit: number): DataUrlResult {
	const comma = href.indexOf(",")

	if (!href.startsWith("data:") || comma < 0) {
		return { status: "malformed" }
	}

	const meta = href.slice("data:".length, comma)
	const body = href.slice(comma + 1)
	const isBase64 = /;base64$/i.test(meta)
	const type = (isBase64 ? meta.slice(0, -";base64".length) : meta) || "text/plain;charset=US-ASCII"
	const bound = isBase64 ? Math.floor((body.length * 3) / 4) : new TextEncoder().encode(body).length

	if (bound > limit) {
		return { status: "overBudget" }
	}

	const bytes = isBase64 ? base64Decode(body) : percentDecode(body)

	return bytes === null ? { status: "malformed" } : { status: "ok", bytes, type }
}

export interface ResourceBudget {
	readonly remaining: number
	// False, and nothing taken, when `bytes` do not fit.
	take(bytes: number): boolean
	give(bytes: number): void
}

export function resourceBudget(limit: number): ResourceBudget {
	let used = 0

	return {
		get remaining() {
			return limit - used
		},
		take: bytes => {
			if (used + bytes > limit) {
				return false
			}

			used += bytes

			return true
		},
		give: bytes => {
			used = Math.max(0, used - bytes)
		}
	}
}
