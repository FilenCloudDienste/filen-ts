import { type } from "arktype"
import type { DesktopMountPointProblem, DesktopMountsError, DesktopMountsErrorCode } from "@filen/shared/desktop"
import type { MountsKey } from "@/lib/i18n"

export const MOUNTS_ERROR_KEY: Record<DesktopMountsErrorCode, MountsKey> = {
	hostUnavailable: "errorHostUnavailable",
	fuseMissing: "errorFuseMissing",
	mountPointInvalid: "errorMountPointInvalid",
	mountPointNotEmpty: "errorMountPointNotEmpty",
	mountPointInUse: "errorMountPointInUse",
	driveLetterInUse: "errorDriveLetterInUse",
	portInUse: "errorPortInUse",
	addressUnavailable: "errorAddressUnavailable",
	authRequired: "errorAuthRequired",
	uploadsPending: "errorUploadsPending",
	unsupportedProtocol: "errorUnsupportedProtocol",
	binaryInvalid: "errorBinaryInvalid",
	unauthenticated: "errorUnauthenticated",
	timeout: "errorTimeout",
	mountPointExpired: "errorMountPointExpired",
	credentialsInvalid: "errorCredentialsInvalid",
	credentialsWeak: "errorCredentialsWeak",
	acknowledgementRequired: "errorAcknowledgementRequired",
	unknown: "errorUnknown"
}

export const MOUNT_POINT_PROBLEM_KEY: Record<DesktopMountPointProblem, MountsKey> = {
	notDirectory: "problemNotDirectory",
	notEmpty: "problemNotEmpty",
	symlink: "problemSymlink",
	outsideHome: "problemOutsideHome",
	homeDirectory: "problemHomeDirectory",
	appData: "problemAppData",
	temporary: "problemTemporary",
	insidePair: "problemInsidePair",
	containsPair: "problemContainsPair"
}

export const MOUNT_POINT_PROBLEMS = [
	"notDirectory",
	"notEmpty",
	"symlink",
	"outsideHome",
	"homeDirectory",
	"appData",
	"temporary",
	"insidePair",
	"containsPair"
] as const satisfies readonly DesktopMountPointProblem[]

const mountPointProblem = type.enumerated(...MOUNT_POINT_PROBLEMS)

// A refused mount point carries its problem as the message; that says more than the code.
export function mountsErrorKey(error: DesktopMountsError): MountsKey {
	if (error.code === "mountPointInvalid" && mountPointProblem.allows(error.message)) {
		return MOUNT_POINT_PROBLEM_KEY[error.message]
	}

	return MOUNTS_ERROR_KEY[error.code]
}
