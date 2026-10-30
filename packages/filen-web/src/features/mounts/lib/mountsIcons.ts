import {
	AppWindowIcon,
	ArchiveIcon,
	CloudIcon,
	DatabaseIcon,
	GlobeIcon,
	HardDriveIcon,
	NetworkIcon,
	ServerIcon,
	ShieldCheckIcon,
	type LucideIcon
} from "lucide-react"
import type { MountsRole, ServeProtocol } from "@/features/mounts/lib/mountsRoles"

// One glyph per server, so the sidebar and the overview tell them apart at a glance: WebDAV is the web's file
// protocol, S3 an object store, FTP a plain file server, SFTP its secure sibling, HTTP a browser listing, restic a
// backup repository, NFS a network share.
export const PROTOCOL_ICON: Record<ServeProtocol, LucideIcon> = {
	webdav: GlobeIcon,
	s3: DatabaseIcon,
	ftp: ServerIcon,
	sftp: ShieldCheckIcon,
	http: AppWindowIcon,
	restic: ArchiveIcon,
	nfs: NetworkIcon
}

// Filen in Finder is the cloud showing in Finder; the network drive a disk.
export const ROLE_ICON: Record<MountsRole, LucideIcon> = { finder: CloudIcon, drive: HardDriveIcon, ...PROTOCOL_ICON }
