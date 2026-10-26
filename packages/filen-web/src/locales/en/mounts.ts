// English source catalog — "mounts" namespace: the desktop app's network drive and the servers that expose the
// drive over a protocol (the Mounts section). Same typed-catalog rules as every other namespace: flat `as const`
// object, camelCase keys, no literal '.' or ':'. "directory" never "folder".
export const mounts = {
	// ── Sidebar ─────────────────────────────────────────────────────────
	/** Sidebar — accessible name of the width drag handle */
	mountsSidebarResize: "Resize sidebar",
	/** Sidebar — the network drive row (the drive mounted as a disk on this device) */
	mountsNetworkDrive: "Network drive",
	/** Sidebar — heading over the protocol servers that expose the drive */
	mountsServersHeading: "Servers",

	// ── Protocol names ──────────────────────────────────────────────────
	/** Protocol name — WebDAV server */
	protocolWebdav: "WebDAV",
	/** Protocol name — S3-compatible server */
	protocolS3: "S3",
	/** Protocol name — FTP server */
	protocolFtp: "FTP",
	/** Protocol name — SFTP server */
	protocolSftp: "SFTP",
	/** Protocol name — HTTP file listing server */
	protocolHttp: "HTTP",
	/** Protocol name — restic REST backup server (restic is the backup tool's lowercase name) */
	protocolRestic: "restic",
	/** Protocol name — NFS server */
	protocolNfs: "NFS"
} as const
