// Two error species cross the worker boundary: plain `Error` (from wasm-bindgen marshalling /
// JS) and the SDK's `FilenSdkError` (string `kind` + accessor METHODS). `FilenSdkError` clones
// HOLLOW across postMessage (its data lives behind a wasm pointer), so every error must be
// extracted to this plain, structured-clone-safe DTO BEFORE it crosses Comlink. i18n mapping of
// `kind` lives main-thread; this module stays worker-safe (no DOM, no i18n).

export interface ErrorDTO {
	species: "sdk" | "plain"
	kind?: string
	label: string
	message: string
	innerMessage?: string
	serverMessage?: string
	serverCode?: string
}

// LABEL-FIRST: the most user-meaningful string wins — the server's own message,
// else the inner detail, else the outer message.
export function labelFirst(dto: ErrorDTO): string {
	return dto.serverMessage ?? dto.innerMessage ?? dto.message
}

// Call a wasm accessor method by name, tolerating a missing/non-function/throwing accessor and
// empty strings (a hollow clone's accessors are gone entirely).
function callAccessor(o: object, m: string): string | undefined {
	const fn = (o as Record<string, unknown>)[m]
	if (typeof fn !== "function") {
		return undefined
	}
	try {
		const v = (fn as () => unknown).call(o)
		return typeof v === "string" && v !== "" ? v : undefined
	} catch {
		return undefined
	}
}

export function toErrorDTO(e: unknown): ErrorDTO {
	if (typeof e === "object" && e !== null && (e as { constructor?: { name?: string } }).constructor?.name === "FilenSdkError") {
		const kind = (e as { kind?: unknown }).kind
		const message = callAccessor(e, "message") ?? (e instanceof Error ? e.message : "unknown SDK error")
		const innerMessage = callAccessor(e, "inner_message")
		const serverMessage = callAccessor(e, "server_message")
		const serverCode = callAccessor(e, "server_code")
		const dto: ErrorDTO = {
			species: "sdk",
			...(typeof kind === "string" ? { kind } : {}),
			message,
			...(innerMessage !== undefined ? { innerMessage } : {}),
			...(serverMessage !== undefined ? { serverMessage } : {}),
			...(serverCode !== undefined ? { serverCode } : {}),
			label: ""
		}
		dto.label = labelFirst(dto)
		return dto
	}
	const message = e instanceof Error ? e.message : String(e)
	return { species: "plain", message, label: message }
}
