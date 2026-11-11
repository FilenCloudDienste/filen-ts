import type { DesktopTransferError, DesktopTransferErrorCode } from "@filen/shared/desktop"
import { SdkShapeError } from "@filen/shared/sdkShapes"
import { clip } from "./errors.ts"

// The SDK surface classifyTransfer reads.
export interface TransferErrorSdk {
	FilenSdkError: {
		hasInner(error: unknown): boolean
		getInner(error: unknown): { kind(): number; innerMessage(): string | undefined; message(): string }
	}
	ErrorKind: { readonly Unauthenticated: number; readonly Cancelled: number; readonly Io: number; readonly MaxStorageReached: number }
}

// A local step of a transfer that failed in a way the page names (a target another app holds open).
export class TransferCommitError extends Error {
	readonly code: DesktopTransferErrorCode

	constructor(code: DesktopTransferErrorCode, message: string) {
		super(message)
		this.code = code
	}
}

const KIND_MAX = 64

// Node's codes for a local step the host ran itself (stat, mkdir, link, rename).
const NODE_CODES: Partial<Record<string, DesktopTransferErrorCode>> = {
	ENOENT: "localMissing",
	ENOTDIR: "localMissing",
	EACCES: "localDenied",
	EPERM: "localDenied",
	EROFS: "localDenied",
	ENOSPC: "localFull",
	EDQUOT: "localFull",
	EBUSY: "localInUse"
}

// The SDK's Io errors carry std::io::Error's text: the OS's description and its code ("(os error 2)"). The codes
// differ per OS: errno on macOS and Linux, Win32 error codes on Windows (FILE_NOT_FOUND 2, PATH_NOT_FOUND 3,
// ACCESS_DENIED 5, SHARING_VIOLATION 32, LOCK_VIOLATION 33, DISK_FULL 112, HANDLE_DISK_FULL 39).
// errno, same numbers on macOS and Linux: ENOENT 2, ENOTDIR 20, EPERM 1, EACCES 13, EROFS 30, ENOSPC 28, EBUSY 16.
const POSIX_IO: Readonly<Record<number, DesktopTransferErrorCode>> = {
	2: "localMissing",
	20: "localMissing",
	1: "localDenied",
	13: "localDenied",
	30: "localDenied",
	28: "localFull",
	16: "localInUse"
}
const WIN32_IO: Readonly<Record<number, DesktopTransferErrorCode>> = {
	2: "localMissing",
	3: "localMissing",
	5: "localDenied",
	32: "localInUse",
	33: "localInUse",
	39: "localFull",
	112: "localFull"
}

function ioCode(message: string, platform: NodeJS.Platform): DesktopTransferErrorCode | undefined {
	const os = /\(os error (\d+)\)/.exec(message)?.[1]

	return os === undefined ? undefined : (platform === "win32" ? WIN32_IO : POSIX_IO)[Number(os)]
}

function kindName(sdk: TransferErrorSdk, kind: number): string {
	for (const [name, value] of Object.entries(sdk.ErrorKind)) {
		if (value === kind) {
			return name.slice(0, KIND_MAX)
		}
	}

	return String(kind)
}

export function isCancelled(sdk: TransferErrorSdk, error: unknown): boolean {
	return sdk.FilenSdkError.hasInner(error) && sdk.FilenSdkError.getInner(error).kind() === sdk.ErrorKind.Cancelled
}

// What a failed transfer step means for the page. Messages are clipped to the protocol's limit; they name paths at
// most, never an SDK object.
export function classifyTransfer(
	sdk: TransferErrorSdk,
	error: unknown,
	platform: NodeJS.Platform = process.platform
): DesktopTransferError {
	if (error instanceof TransferCommitError) {
		return { code: error.code, message: clip(error.message) }
	}

	if (error instanceof SdkShapeError) {
		return { code: "invalidItem", message: clip(error.message) }
	}

	if (!sdk.FilenSdkError.hasInner(error)) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
		const mapped = typeof code === "string" ? NODE_CODES[code] : undefined

		return { code: mapped ?? "unknown", message: clip(error instanceof Error ? error.message : String(error)) }
	}

	const inner = sdk.FilenSdkError.getInner(error)
	const kind = inner.kind()
	const message = clip(inner.innerMessage() ?? inner.message())
	const named = { kind: kindName(sdk, kind), message }

	if (kind === sdk.ErrorKind.Unauthenticated) {
		return { code: "unauthenticated", ...named }
	}

	if (kind === sdk.ErrorKind.MaxStorageReached) {
		return { code: "storageFull", ...named }
	}

	return { code: (kind === sdk.ErrorKind.Io ? ioCode(message, platform) : undefined) ?? "unknown", ...named }
}
