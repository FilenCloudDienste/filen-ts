import { type } from "arktype"
import type {
	DesktopFuseInstall,
	DesktopFuseStatus,
	DesktopListenAddress,
	DesktopMountsNotice,
	DesktopMountsOverview,
	DesktopMountsRole,
	DesktopMountsRoleState,
	DesktopServe,
	DesktopServeProtocol
} from "@filen/shared/desktop"
import type { MountsKey } from "@/lib/i18n"

// The rail's one-glance state: anything the user has to act on wins over uploads still leaving the drive's cache.
export type MountsAggregate = "idle" | "uploading" | "attention"

// null before the first overview (and always in a browser). The native host is shared with sync, so its failure counts
// here only while something is meant to run.
export function aggregateMountsState(overview: DesktopMountsOverview | null): MountsAggregate | null {
	if (overview === null) {
		return null
	}

	const { drive, serves, cache } = overview
	const wanted = drive.enabled || serves.some(serve => serve.enabled)

	if ((wanted && overview.host.state === "failed") || drive.state === "error" || serves.some(serve => serve.state === "error")) {
		return "attention"
	}

	if (cache.erroredFiles > 0) {
		return "attention"
	}

	return cache.pendingUploads > 0 ? "uploading" : "idle"
}

export const ROLE_STATE_KEY: Record<DesktopMountsRoleState, MountsKey> = {
	off: "stateOff",
	starting: "stateStarting",
	running: "stateRunning",
	stopping: "stateStopping",
	error: "stateError"
}

// A running drive reads "Mounted"; every other role and state reads its state.
export function roleStateKey(role: DesktopMountsRole, state: DesktopMountsRoleState): MountsKey {
	return role === "drive" && state === "running" ? "stateMounted" : ROLE_STATE_KEY[state]
}

// Mid-transition: its switch waits for the shell to settle the role.
export function roleBusy(state: DesktopMountsRoleState): boolean {
	return state === "starting" || state === "stopping"
}

// The drive's read-only flag is part of how it is mounted, so it changes only while the drive is down.
export function driveReadOnlyLocked(state: DesktopMountsRoleState): boolean {
	return state !== "off" && state !== "error"
}

export const NOTICE_KEY: Record<DesktopMountsNotice, MountsKey> = {
	credentialsRegenerated: "noticeCredentialsRegenerated",
	addressInvalid: "noticeAddressInvalid",
	mountPointInvalid: "noticeMountPointInvalid",
	legacyUploadsPending: "noticeLegacyUploadsPending",
	legacyCacheErrored: "noticeLegacyCacheErrored",
	certificateRegenerated: "noticeCertificateRegenerated"
}

// Which page tells a notice: the drive's own, or every server's.
export const NOTICE_SCOPE: Record<DesktopMountsNotice, "drive" | "serve"> = {
	credentialsRegenerated: "serve",
	addressInvalid: "serve",
	mountPointInvalid: "drive",
	legacyUploadsPending: "drive",
	legacyCacheErrored: "drive",
	certificateRegenerated: "serve"
}

export const FUSE_PROVIDER_KEY: Record<Extract<DesktopFuseStatus, { state: "ready" }>["provider"], MountsKey> = {
	macFuse: "fuseProviderMacFuse",
	nfsMount: "fuseProviderNfsMount",
	winFsp: "fuseProviderWinFsp",
	fuse3: "fuseProviderFuse3"
}

export const FUSE_GAP_KEY: Record<NonNullable<DesktopMountsOverview["fuseGap"]>, MountsKey> = {
	fuse3: "fuseMissingFuse3",
	device: "fuseMissingDevice"
}

export const FUSE_INSTALL_KEY: Record<DesktopFuseInstall, MountsKey> = {
	installed: "fuseInstallInstalled",
	rebootRequired: "fuseInstallRebootRequired",
	canceled: "fuseInstallCanceled",
	failed: "fuseInstallFailed"
}

// What a client needs beyond the URL, per protocol.
export const CONNECT_HINT_KEY: Record<DesktopServeProtocol, MountsKey> = {
	webdav: "connectHintWebdav",
	s3: "connectHintS3",
	ftp: "connectHintFtp",
	sftp: "connectHintSftp",
	http: "connectHintHttp",
	restic: "connectHintRestic",
	nfs: "connectHintNfs"
}

export const ADDRESS_KIND_KEY: Record<DesktopListenAddress["kind"], "addressLoopback" | "addressLan" | "addressAll"> = {
	loopback: "addressLoopback",
	lan: "addressLan",
	all: "addressAll"
}

// The addresses a server may pick: nfs has no authentication, so it stays on this device.
export function addressChoices(protocol: DesktopServeProtocol, addresses: readonly DesktopListenAddress[]): DesktopListenAddress[] {
	return protocol === "nfs" ? addresses.filter(address => address.kind === "loopback") : [...addresses]
}

// Off loopback, an https-capable server without https sends its credentials in plain text. The shell ticks https when
// a server first leaves loopback; turning it off there needs the user's word.
export function sendsPlainText(serve: Pick<DesktopServe, "addressKind" | "httpsCapable" | "https" | "authenticated">): boolean {
	return serve.authenticated && serve.httpsCapable && !serve.https && serve.addressKind !== "loopback"
}

export function httpsOffNeedsWarning(serve: Pick<DesktopServe, "addressKind" | "httpsCapable" | "authenticated">): boolean {
	return sendsPlainText({ ...serve, https: false })
}

// A server without authentication (nfs) starts only once the user acknowledged that anyone on this device can use it.
export function enableNeedsAcknowledgement(serve: Pick<DesktopServe, "authenticated">): boolean {
	return !serve.authenticated
}

// Typed form fields, parsed to the bounds the shell enforces.
export const portInput = type("string.integer.parse").to("1 <= number <= 65535")

export const tuningInput = type({
	cacheMaxGiB: type("string.integer.parse").to("1 <= number <= 65536"),
	cacheMinFreeGiB: type("string.integer.parse").to("0 <= number <= 65536"),
	cacheMaxAgeHours: type("string.integer.parse").to("1 <= number <= 87600"),
	dirCacheSeconds: type("string.integer.parse").to("1 <= number <= 86400")
})

// What a server's two credential parts are called: an s3 key pair, else a user name and password.
export function credentialLabels(protocol: DesktopServeProtocol): { user: MountsKey; secret: MountsKey } {
	return protocol === "s3"
		? { user: "credentialAccessKeyId", secret: "credentialSecretAccessKey" }
		: { user: "credentialUser", secret: "credentialPassword" }
}
