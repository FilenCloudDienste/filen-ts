import { sanitizeUntrustedText, type AssistantSignal } from "@filen/shared/assistant"
import type { AssistantHandleRef } from "@/features/assistant/runtime/executor"

// Name matching lives in @filen/shared, where the eval's fake app matches names the same way.
export { matchScore, sameName, searchTokens } from "@filen/shared/assistant"

// Model-facing text is English, like the system prompt; names keep the app's own labels.

// A call the app refused, worded for the model. `invalid` marks a malformed call (wrong handle kind, a
// name where a handle belongs) as opposed to a valid one that failed; `candidates` are handles whose
// names match what the model passed, so it can call again with one.
export class AssistantToolError extends Error {
	readonly invalid: boolean
	readonly candidates: AssistantHandleRef[]

	constructor(message: string, options: { invalid?: boolean; candidates?: AssistantHandleRef[] } = {}) {
		super(message)
		this.name = "AssistantToolError"
		this.invalid = options.invalid ?? false
		this.candidates = options.candidates ?? []
	}
}

// Settles with `work`, or as stopped as soon as the turn is: a call waiting on an offline fetch (a listing
// query stays paused while the browser is offline) or a blocked navigation does not hold the turn, and with
// it the model.
export function unlessStopped<T>(work: Promise<T>, signal: AssistantSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new AssistantToolError("Stopped"))
	}

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(new AssistantToolError("Stopped"))
		}

		signal.addEventListener("abort", onAbort, { once: true })
		void work.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort)
		})
	})
}

// After an await that preceded a side effect (a navigation, playback): a stopped turn does nothing more.
export function throwIfStopped(scope: { signal: { readonly aborted: boolean } | undefined }): void {
	if (scope.signal?.aborted === true) {
		throw new AssistantToolError("Stopped")
	}
}

// Every string in a result, sanitized: values mix the app's own words with names and text other people
// wrote, and sanitizing the app's own words changes nothing. The joiners a word is spelled with stay, so
// the model reads and quotes Persian or Indic text as written; the loop adds the model's own tokens.
export function sanitizeStrings(value: unknown): unknown {
	if (typeof value === "string") {
		return sanitizeUntrustedText(value, [], { keepJoiners: true })
	}

	if (Array.isArray(value)) {
		return value.map(entry => sanitizeStrings(entry))
	}

	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeStrings(entry)]))
	}

	return value
}

// Long text cut at `max` characters, never inside a surrogate pair.
export function clipText(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) {
		return { text, truncated: false }
	}

	const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max

	return { text: text.slice(0, end), truncated: true }
}

// The user's own calendar date, as the "Today" line in the system prompt counts days.
export function isoDate(timestamp: bigint | number): string {
	const date = new Date(Number(timestamp))

	if (Number.isNaN(date.getTime())) {
		return ""
	}

	const pad = (value: number) => String(value).padStart(2, "0")

	return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
