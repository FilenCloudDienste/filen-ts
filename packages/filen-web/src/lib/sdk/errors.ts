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
	// A custom Error subclass's own `.name` is the only identity that can survive this boundary — its
	// class/prototype never does (sdk.worker.ts's Comlink.expose proxy structured-clones every thrown
	// value into a plain object before it ever reaches Comlink's own — separately lossy — Error
	// handling, so `instanceof`/constructor checks are unavailable to any main-thread catch regardless
	// of which layer is asked). Carrying a meaningful `.name` through as `kind` lets a caller
	// discriminate a specific plain-Error case the same way it already would an SDK error's own `kind`,
	// without matching on message text. The default, unset `.name` ("Error") carries no information and
	// is excluded so it doesn't masquerade as a real kind.
	const kind = e instanceof Error && e.name !== "" && e.name !== "Error" ? e.name : undefined
	return { species: "plain", message, label: message, ...(kind !== undefined ? { kind } : {}) }
}

// Canonical entry point for an UNKNOWN rejection. The SDK worker's Comlink boundary already throws a
// plain, structured-clone-safe ErrorDTO, so those pass through untouched — re-running toErrorDTO on
// one would misclassify it as plain garbage (`String(dto)` → "[object Object]"). Everything else (a
// live SDK error, a raw Error, a transport failure that never crossed the boundary) is normalized.
export function asErrorDTO(e: unknown): ErrorDTO {
	return typeof e === "object" && e !== null && "species" in e && "label" in e ? (e as ErrorDTO) : toErrorDTO(e)
}

// resolveNormalDirParent's own thrown message (sdk.worker.ts) when a create/move/save target's parent
// directory no longer exists — shared here rather than duplicated since it's the one signal
// main-thread logic needs out of a worker throw's otherwise-opaque plain Error (see
// previewSave.logic.ts's own isUnresolvableParentError, today's only consumer). Not a general
// error-kind taxonomy entry: a plain Error has no `kind`, only this literal `message` prefix to match.
export const PARENT_NOT_FOUND_PREFIX = "parent directory not found: "

// listDirectory's own thrown message (sdk.worker.ts, `kind: "uuid"` branch) when the uuid a caller
// asked to browse into no longer resolves — the signal photos' root-gone detection keys off of (a
// saved root directory that was trashed/deleted elsewhere), same message-prefix convention as
// PARENT_NOT_FOUND_PREFIX right above.
export const DIRECTORY_NOT_FOUND_PREFIX = "directory not found: "
