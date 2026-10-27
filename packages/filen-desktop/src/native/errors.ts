import type { DesktopSyncErrorCode } from "@filen/shared/desktop"
import type { NativeError } from "../shared/nativeProtocol.ts"
import type { NativeSdk } from "./addon.ts"

// The protocol's text limit; an engine message or path past it would fail main's validation and restart the host.
const TEXT_MAX = 4096

export function clip(text: string): string {
	return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text
}

// An error the host raises itself, before any engine call.
export class HostError extends Error {
	readonly error: NativeError

	constructor(error: NativeError) {
		super(error.code)
		this.error = error
	}
}

const REFUSALS: Partial<Record<string, DesktopSyncErrorCode>> = {
	LocalRootInUse: "localRootInUse",
	LocalRootNested: "localRootNested",
	LocalRootContains: "localRootContains",
	RemoteRootInUse: "remoteRootInUse",
	RemoteRootNested: "remoteRootNested",
	RemoteRootContains: "remoteRootContains"
}

// What a failed engine call means for main. "unauthenticated" — the server no longer takes the session — is only ever
// read off the SDK's error kind (its gateway code), never off an HTTP status or a message.
export function classify(sdk: NativeSdk, error: unknown): NativeError | "unauthenticated" {
	if (error instanceof HostError) {
		return error.error
	}

	if (!sdk.FilenSdkError.hasInner(error)) {
		return { code: "unknown", message: clip(error instanceof Error ? error.message : String(error)) }
	}

	const inner = sdk.FilenSdkError.getInner(error)
	const kind = inner.kind()

	if (kind === sdk.ErrorKind.Unauthenticated) {
		return "unauthenticated"
	}

	const refusal = inner.syncRefusal()
	const refused = refusal === undefined ? undefined : REFUSALS[refusal.tag]

	if (refused !== undefined) {
		return { code: refused }
	}

	if (kind === sdk.ErrorKind.FolderNotFound) {
		return { code: "remoteRootMissing" }
	}

	const message = inner.innerMessage() ?? inner.message()

	// The engine names these two only in its message.
	if (message.includes("unknown sync pair")) {
		return { code: "pairNotFound" }
	}

	if (message.includes("is already registered for these roots")) {
		return { code: "modeConflict", message: clip(message) }
	}

	return { code: "unknown", message: clip(message) }
}

// The SDK error kind's name, for a log.
export function errorKind(sdk: NativeSdk, error: unknown): string {
	if (!sdk.FilenSdkError.hasInner(error)) {
		return "unknown"
	}

	const kind = sdk.FilenSdkError.getInner(error).kind()

	return Object.entries(sdk.ErrorKind).find(([, value]) => value === kind)?.[0] ?? String(kind)
}

// A refused user ignore text, with the 1-based line the engine names
// (`refusing the user ignore patterns: user ignore patterns:3: …`); null for any other error.
export function invalidIgnore(error: NativeError | "unauthenticated"): NativeError | null {
	const message = error === "unauthenticated" || error.code !== "unknown" ? undefined : error.message

	if (message === undefined || !message.includes("refusing the user ignore patterns")) {
		return null
	}

	const line = /user ignore patterns:(\d+):/.exec(message)?.[1]

	return line === undefined ? { code: "invalidIgnore", message } : { code: "invalidIgnore", line: Number(line), message }
}
