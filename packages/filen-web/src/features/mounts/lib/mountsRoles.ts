import type { DesktopMountsRole, DesktopPlatform, DesktopServeProtocol } from "@filen/shared/desktop"
import type { MountsKey } from "@/lib/i18n"

// The protocols the drive can be served over, in sidebar order. NFS has no Windows server.
export const SERVE_PROTOCOLS = ["webdav", "s3", "ftp", "sftp", "http", "restic", "nfs"] as const satisfies readonly DesktopServeProtocol[]

export type ServeProtocol = DesktopServeProtocol

// A Mounts page: the network drive or one protocol's server.
export type MountsRole = DesktopMountsRole

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

// Whether `role` names a page this platform offers; anything else (a typo, nfs on Windows) is not one.
export function isOfferedRole(role: string, platform: DesktopPlatform | undefined): role is MountsRole {
	return role === "drive" || offeredProtocols(platform).some(protocol => protocol === role)
}
