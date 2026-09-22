// Shared type-checks against ESNext only. These are the runtime globals both Hermes and browsers
// provide, declared with the minimal shape the modules use. Anything else that fails to resolve is
// a platform leak and must not enter this package.

declare function setTimeout(handler: () => void, timeout?: number): number
declare function clearTimeout(timeoutId: number): void

declare class AbortSignal {
	readonly aborted: boolean
	readonly reason: unknown
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
	removeEventListener(type: "abort", listener: () => void): void
}

declare class AbortController {
	readonly signal: AbortSignal
	abort(reason?: unknown): void
}

// Must be a value declaration: isAbortError narrows with `instanceof`.
declare class DOMException extends Error {
	constructor(message?: string, name?: string)
	readonly code: number
}

declare class TextEncoder {
	encode(input?: string): Uint8Array
}

declare class TextDecoder {
	constructor(label?: string, options?: { fatal?: boolean })
	decode(input?: Uint8Array): string
}
