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

// SDK errors are detected by DUCK-TYPING the wasm surface, never by class name: the sdk-rs glue
// class is minified to a mangled identifier in the production worker bundle (and does NOT extend
// Error), so a `constructor.name` check misclassifies EVERY SDK error as plain. wasm-bindgen
// method/getter names survive minification, so probe them directly — a live FilenSdkError exposes a
// `kind` string getter plus a `server_message` accessor METHOD. A hollow structured clone (post-
// Comlink) has lost its prototype methods entirely, so it fails the method probe and correctly falls
// through to the "plain" branch; that loss is precisely what makes this check safe. The method probe
// runs first (a cheap lookup) so the `kind` getter is only ever invoked on a genuine SDK error.
function isSdkError(e: unknown): e is { kind: string; server_message: () => unknown } {
	return (
		typeof e === "object" &&
		e !== null &&
		typeof (e as { server_message?: unknown }).server_message === "function" &&
		typeof (e as { kind?: unknown }).kind === "string"
	)
}

export function toErrorDTO(e: unknown): ErrorDTO {
	if (isSdkError(e)) {
		const message = callAccessor(e, "message") ?? (e instanceof Error ? e.message : "unknown SDK error")
		const innerMessage = callAccessor(e, "inner_message")
		const serverMessage = callAccessor(e, "server_message")
		const serverCode = callAccessor(e, "server_code")
		const dto: ErrorDTO = {
			species: "sdk",
			kind: e.kind,
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

// Canonical entry point for an UNKNOWN rejection. The SDK worker's Comlink boundary already throws a
// plain, structured-clone-safe ErrorDTO, so those pass through untouched — re-running toErrorDTO on
// one would misclassify it as plain garbage (`String(dto)` → "[object Object]"). Everything else (a
// live SDK error, a raw Error, a transport failure that never crossed the boundary) is normalized.
export function asErrorDTO(e: unknown): ErrorDTO {
	return typeof e === "object" && e !== null && "species" in e && "label" in e ? (e as ErrorDTO) : toErrorDTO(e)
}
