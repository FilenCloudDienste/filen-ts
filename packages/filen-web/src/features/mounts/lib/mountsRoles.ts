import type { DesktopMountsRole, DesktopPlatform, DesktopServeProtocol } from "@filen/shared/desktop"
import type { MountsKey } from "@/lib/i18n"

// The protocols the drive can be served over, in sidebar order. NFS has no Windows server.
export const SERVE_PROTOCOLS = ["webdav", "s3", "ftp", "sftp", "http", "restic", "nfs"] as const satisfies readonly DesktopServeProtocol[]

export type ServeProtocol = DesktopServeProtocol

// Filen in Finder: the macOS File Provider, run by the shell itself rather than the native host.
export const FINDER_ROLE = "finder"

// A Mounts page: Filen in Finder, the network drive or one protocol's server.
export type MountsRole = typeof FINDER_ROLE | DesktopMountsRole

// What this app offers on Mounts: the platform's servers, and Filen in Finder where the shell supports it (macOS 14
// and later). Both are fixed for the session.
export interface MountsOffer {
	platform: DesktopPlatform | undefined
	finder: boolean
}

export const PROTOCOL_LABEL_KEY: Record<ServeProtocol, MountsKey> = {
	webdav: "protocolWebdav",
	s3: "protocolS3",
	ftp: "protocolFtp",
	sftp: "protocolSftp",
	http: "protocolHttp",
	restic: "protocolRestic",
	nfs: "protocolNfs"
}

const WITHOUT_NFS: readonly ServeProtocol[] = SERVE_PROTOCOLS.filter(protocol => protocol !== "nfs")

export function offeredProtocols(platform: DesktopPlatform | undefined): readonly ServeProtocol[] {
	return platform === "win32" ? WITHOUT_NFS : SERVE_PROTOCOLS
}

const WITH_FINDER: readonly MountsRole[] = [FINDER_ROLE, "drive"]
const DRIVE_ONLY: readonly MountsRole[] = ["drive"]

// The pages above the servers, in sidebar and overview order: Filen in Finder, where offered, comes first as the
// recommended way, the network drive after it.
export function primaryRoles(finder: boolean): readonly MountsRole[] {
	return finder ? WITH_FINDER : DRIVE_ONLY
}

// Whether `role` names a page this app offers; anything else (a typo, nfs on Windows, Filen in Finder off macOS 14)
// is not one.
export function isOfferedRole(role: string, offer: MountsOffer): role is MountsRole {
	return (
		primaryRoles(offer.finder).some(primary => primary === role) || offeredProtocols(offer.platform).some(protocol => protocol === role)
	)
}
