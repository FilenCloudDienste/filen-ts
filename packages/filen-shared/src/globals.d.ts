// Shared type-checks against ESNext only. These are the runtime globals both Hermes and browsers
// provide, declared with the minimal shape the modules use. Anything else that fails to resolve is
// a platform leak and must not enter this package.

declare function setTimeout(handler: () => void, timeout?: number): number
declare function clearTimeout(timeoutId: number): void

declare class TextEncoder {
	encode(input?: string): Uint8Array
}
