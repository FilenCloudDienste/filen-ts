import type { RcloneRefusal } from "@filen/sdk-rs"
import type { DesktopMountsErrorCode } from "@filen/shared/desktop"
import type { NativeMountsError } from "../../shared/nativeProtocol.ts"
import type { NativeSdk } from "../addon.ts"
import { clip } from "../errors.ts"

// An error the host raises itself, before or instead of an SDK call.
export class MountsError extends Error {
	readonly error: NativeMountsError

	constructor(error: NativeMountsError) {
		super(error.code)
		this.error = error
	}
}

// What each refusal of the SDK's rclone module means for main; the rest keep the SDK's message.
const REFUSALS: Record<RcloneRefusal["tag"], DesktopMountsErrorCode> = {
	BinaryMissing: "binaryInvalid",
	BinaryChecksum: "binaryInvalid",
	UnsupportedVersion: "binaryInvalid",
	WatchdogUnavailable: "unknown",
	FuseMissing: "fuseMissing",
	MountPointInUse: "mountPointInUse",
	MountPointNotEmpty: "mountPointNotEmpty",
	MountPointInvalid: "mountPointInvalid",
	DriveLetterInUse: "driveLetterInUse",
	PortInUse: "portInUse",
	AddressNotLocal: "addressUnavailable",
	ImplicitAddress: "addressUnavailable",
	AuthRequired: "authRequired",
	InvalidCredentials: "credentialsInvalid",
	UnauthenticatedOffLoopback: "authRequired",
	UnsupportedProtocol: "unsupportedProtocol",
	TlsUnsupported: "unsupportedProtocol",
	UploadsPending: "uploadsPending",
	CacheInUse: "unknown"
}

function messageOf(error: unknown): string {
	return clip(error instanceof Error ? error.message : String(error))
}

// What a failed rclone call means for main. "unauthenticated" (the server no longer takes the session) is read off the
// SDK's error kind only. The SDK's messages carry rc's error line, never a request body, so no credential is in them.
export function classifyMounts(sdk: NativeSdk, error: unknown): NativeMountsError | "unauthenticated" {
	if (error instanceof MountsError) {
		return error.error
	}

	if (!sdk.FilenSdkError.hasInner(error)) {
		return { code: "unknown", message: messageOf(error) }
	}

	const inner = sdk.FilenSdkError.getInner(error)

	if (inner.kind() === sdk.ErrorKind.Unauthenticated) {
		return "unauthenticated"
	}

	const refusal = inner.rcloneRefusal()
	const code = refusal === undefined ? "unknown" : REFUSALS[refusal.tag]

	return code === "unknown" ? { code, message: clip(inner.innerMessage() ?? inner.message()) } : { code }
}

// The number of files a cache-clearing refusal says are not uploaded yet; null for any other error.
export function pendingRefusal(sdk: NativeSdk, error: unknown): number | null {
	if (!sdk.FilenSdkError.hasInner(error)) {
		return null
	}

	const refusal = sdk.FilenSdkError.getInner(error).rcloneRefusal()

	return refusal?.tag === "UploadsPending" ? refusal.inner.count : null
}
