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

	/** Rail — accessible name of the Mounts entry when a mount or server needs attention */
	railAttention: "Mounts, needs attention",
	/** Rail — accessible name of the Mounts entry while the drive's cache still uploads */
	railUploading: "Mounts, uploading",

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
	protocolNfs: "NFS",

	// ── Host state banner (the background helper shared with sync) ──────
	/** Host banner — the helper is starting */
	hostStarting: "Starting the Filen helper…",
	/** Host banner — the helper stopped and restarts on its own */
	hostRestarting: "The Filen helper stopped unexpectedly and restarts shortly.",
	/** Host banner — the helper kept crashing and was turned off */
	hostCrashLoop: "The Filen helper kept stopping unexpectedly, so Filen turned it off.",
	/** Host banner — part of the helper is missing from this install */
	hostAddonMissing: "The drive and servers can't run because part of Filen is missing. Reinstall Filen if this keeps happening.",
	/** Host banner — another running Filen holds this account's data */
	hostBaselineInUse: "Another copy of Filen is using this account's data. Quit it and try again.",
	/** Host banner — the session could not be read from the system keychain */
	hostKeychainLocked: "Filen couldn't read your session from the system keychain. Unlock it and try again.",
	/** Host banner — retry button */
	hostRetry: "Try again",

	// ── Role states ─────────────────────────────────────────────────────
	/** Role state — not running */
	stateOff: "Off",
	/** Role state — starting */
	stateStarting: "Starting…",
	/** Role state — a server is running */
	stateRunning: "Running",
	/** Role state — the network drive is mounted */
	stateMounted: "Mounted",
	/** Role state — stopping */
	stateStopping: "Stopping…",
	/** Role state — failed */
	stateError: "Error",

	// ── Index ───────────────────────────────────────────────────────────
	/** Index — title when nothing is picked */
	placeholderTitle: "Network drive and servers",
	/** Index — under the title */
	placeholderDescription: "Mount your Filen drive as a disk on this device, or serve it to other apps over WebDAV, S3 and more.",

	// ── Shared ──────────────────────────────────────────────────────────
	/** Callout — this build has no usable rclone */
	unavailable: "The drive and servers can't run because part of Filen is missing or damaged. Reinstall Filen.",
	/** Button — copy a value */
	copy: "Copy",
	/** Notice — dismiss button */
	noticeDismiss: "Dismiss",

	// ── Notices (told once until dismissed) ─────────────────────────────
	/** Notice — a server's credentials from the old app could not be kept, so new ones were made */
	noticeCredentialsRegenerated:
		"Some servers' credentials from the previous version of Filen couldn't be kept, so Filen made new ones. Clients using the old credentials must sign in with the new ones.",
	/** Notice — a server's address from the old app can't be listened on, so the server is off */
	noticeAddressInvalid:
		"A server's address from the previous version of Filen can't be used any more, so the server is off. Choose an address to run it again.",
	/** Notice — the old mount point can't be used */
	noticeMountPointInvalid:
		"The network drive's old mount point can't be used any more, so the drive is off. Choose a new one to mount it.",
	/** Notice — the old app's caches still hold uploads */
	noticeLegacyUploadsPending: "Files from the previous version of Filen are still uploading. Keep Filen open until they are done.",
	/** Notice — the old app's caches hold uploads that failed */
	noticeLegacyCacheErrored:
		"Some files from the previous version of Filen couldn't be uploaded. Filen keeps them and tries again on the next start.",
	/** Notice — a server's certificate was made anew */
	noticeCertificateRegenerated: "A server's HTTPS certificate was made anew. Clients that trusted the old one must trust the new one.",

	// ── FUSE ────────────────────────────────────────────────────────────
	/** Driver — macFUSE mounts the drive (macOS) */
	fuseProviderMacFuse: "macFUSE",
	/** Driver — the system's NFS client mounts the drive (macOS) */
	fuseProviderNfsMount: "the macOS network file system",
	/** Driver — WinFsp mounts the drive (Windows) */
	fuseProviderWinFsp: "WinFsp",
	/** Driver — FUSE mounts the drive (Linux) */
	fuseProviderFuse3: "FUSE",
	/** FUSE callout — Windows without WinFsp, the app can install it */
	fuseMissingInstallable: "Mounting the drive needs WinFsp, which isn't installed.",
	/** FUSE callout — install button */
	fuseInstall: "Install WinFsp",
	/** FUSE callout — Linux without the fuse3 package */
	fuseMissingFuse3: "Mounting the drive needs the fuse3 package. Install it with your package manager, then try again.",
	/** FUSE callout — Linux without a FUSE device (containers, sandboxes) */
	fuseMissingDevice:
		"This system has no FUSE device (/dev/fuse), as in a container or sandbox, so the drive can't be mounted here. The servers still work.",
	/** FUSE callout — nothing to mount with and nothing to install */
	fuseMissing: "The drive can't be mounted on this system. The servers still work.",
	/** FUSE install result — done */
	fuseInstallInstalled: "WinFsp is installed.",
	/** FUSE install result — done, needs a restart */
	fuseInstallRebootRequired: "WinFsp is installed. Restart your computer to mount the drive.",
	/** FUSE install result — the user said no */
	fuseInstallCanceled: "WinFsp wasn't installed.",
	/** FUSE install result — failed */
	fuseInstallFailed: "WinFsp couldn't be installed.",

	// ── Network drive page ──────────────────────────────────────────────
	/** Drive page — group heading */
	driveGroupDrive: "Drive",
	/** Drive page — enable switch */
	driveEnable: "Mount the drive",
	/** Drive page — enable switch, description */
	driveEnableDescription: "Your Filen drive shows up as a disk on this device. Changes upload in the background.",
	/** Drive page — mount point row (macOS, Linux) */
	driveMountPoint: "Mount point",
	/** Drive page — mount point row, no directory chosen yet */
	driveMountPointDefault: "Filen in your home directory",
	/** Drive page — accessible name of the choose button */
	driveMountPointChoose: "Choose the mount point",
	/** Drive page — choose button */
	driveMountPointChooseAction: "Choose…",
	/** Toast — a chosen mount point was refused; {{reason}} says why */
	mountPointRefused: "{{path}} can't be the mount point. {{reason}}",
	/** Drive page — drive letter row (Windows) */
	driveLetter: "Drive letter",
	/** Drive page — drive letter row, no letter chosen yet */
	driveLetterDefault: "The first free letter from X down.",
	/** Drive page — drive letter row, description */
	driveLetterDescription: "The letter the drive shows up under in File Explorer.",
	/** Drive page — read-only switch */
	driveReadOnly: "Read-only",
	/** Drive page — read-only switch, description */
	driveReadOnlyDescription: "Files can be opened but not changed.",
	/** Drive page — read-only switch while mounted */
	driveReadOnlyLocked: "Turn the drive off to change this.",
	/** Drive page — open row */
	driveOpen: "Open the drive",
	/** Drive page — open row, description; {{provider}} is what mounts it */
	driveOpenDescription: "Mounted with {{provider}}.",
	/** Drive page — open button */
	driveOpenAction: "Open",

	// ── Cache ───────────────────────────────────────────────────────────
	/** Drive page — cache group heading */
	driveGroupCache: "Cache",
	/** Cache — usage row */
	cacheUsage: "Space used",
	/** Cache — usage row, description */
	cacheUsageDescription: "{{used}} used, {{free}} free on this disk",
	/** Cache — uploads waiting row */
	cachePendingLabel: "Waiting to upload",
	/** Cache — uploads waiting, one */
	cachePending_one: "{{count}} file still has to reach the cloud. Keep Filen open until it does.",
	/** Cache — uploads waiting, many */
	cachePending_other: "{{count}} files still have to reach the cloud. Keep Filen open until they do.",
	/** Cache — failed uploads row */
	cacheErroredLabel: "Failed uploads",
	/** Cache — failed uploads, one */
	cacheErrored_one: "{{count}} file couldn't be uploaded. Filen keeps it and tries again.",
	/** Cache — failed uploads, many */
	cacheErrored_other: "{{count}} files couldn't be uploaded. Filen keeps them and tries again.",
	/** Cache — clear row */
	cacheClear: "Clear the cache",
	/** Cache — clear row, description */
	cacheClearDescription: "Removes the copies kept on this device for speed. Files in the cloud are not touched.",
	/** Cache — clear row while uploads wait */
	cacheClearPending: "Can't be cleared while files are waiting to upload.",
	/** Cache — clear button */
	cacheClearAction: "Clear",
	/** Cache — clear confirm title */
	cacheClearTitle: "Clear the cache?",
	/** Cache — clear confirm body */
	cacheClearBody: "The drive and running servers stop for a moment while the cache is cleared. Files in the cloud are not touched.",
	/** Toast — the cache was cleared */
	cacheCleared: "Cache cleared",
	/** Cache — tuning row */
	tuningRow: "Cache settings",
	/** Cache — tuning row, description */
	tuningRowDescription: "Size, age and refresh of the cache the drive and every server share.",
	/** Cache — tuning button */
	tuningOpen: "Change…",

	// ── Cache settings dialog ───────────────────────────────────────────
	/** Tuning dialog — title */
	tuningTitle: "Cache settings",
	/** Tuning dialog — description */
	tuningDescription: "These apply to the network drive and every server. Running ones restart to use them.",
	/** Tuning dialog — save button */
	tuningSave: "Save",
	/** Tuning dialog — maximum cache size field */
	tuningCacheMax: "Maximum cache size (GiB)",
	/** Tuning dialog — maximum cache size range */
	tuningCacheMaxRange: "A whole number from 1 to 65536.",
	/** Tuning dialog — space kept free field */
	tuningMinFree: "Space to keep free on the disk (GiB)",
	/** Tuning dialog — space kept free range */
	tuningMinFreeRange: "A whole number from 0 to 65536.",
	/** Tuning dialog — cached file age field */
	tuningMaxAge: "Keep cached files for (hours)",
	/** Tuning dialog — cached file age range */
	tuningMaxAgeRange: "A whole number from 1 to 87600.",
	/** Tuning dialog — directory listing refresh field */
	tuningDirCache: "Read directory listings again after (seconds)",
	/** Tuning dialog — directory listing refresh range */
	tuningDirCacheRange: "A whole number from 1 to 86400.",

	// ── Transfers ───────────────────────────────────────────────────────
	/** Drive page — transfers group heading */
	transfersHeading: "Uploading",
	/** Drive page — transfers group description */
	transfersCounts: "{{uploading}} uploading, {{queued}} waiting",
	/** Drive page — one transfer's progress */
	transferProgress: "{{bytes}} of {{total}}, {{speed}}",

	// ── Server page ─────────────────────────────────────────────────────
	/** Server page — title; {{protocol}} is the protocol name */
	serveTitle: "{{protocol}} server",
	/** Server page — group heading */
	serveGroupServer: "Server",
	/** Server page — enable switch */
	serveEnable: "Run the server",
	/** Server page — enable switch, description */
	serveEnableDescription: "Serves your Filen drive over {{protocol}} to apps on this device or your network.",
	/** Server page — address row */
	serveAddress: "Listen on",
	/** Server page — address row, description */
	serveAddressDescription: "Who can reach the server.",
	/** Server page — address row, NFS */
	serveAddressNfs: "NFS has no sign-in, so it only listens on this device.",
	/** Address — loopback */
	addressLoopback: "This device only ({{address}})",
	/** Address — one network interface */
	addressLan: "Your network, {{interface}} ({{address}})",
	/** Address — every interface */
	addressAll: "All networks ({{address}})",
	/** Address — the saved address no longer exists on this device */
	addressGone: "{{address}} (not available)",
	/** Server page — port row */
	servePort: "Port",
	/** Server page — port row, invalid entry */
	servePortInvalid: "Enter a port from 1 to 65535.",
	/** Server page — port save button */
	servePortSave: "Save",
	/** Server page — https switch */
	serveHttps: "HTTPS",
	/** Server page — https switch, description */
	serveHttpsDescription: "Encrypts connections with a certificate made on this device.",
	/** Server page — https switch with its certificate's fingerprint */
	serveHttpsFingerprint: "Certificate fingerprint: {{fingerprint}}",
	/** Server page — callout: on the network without https */
	servePlainText: "This server listens on your network without HTTPS, so credentials and files travel in plain text.",
	/** Server page — callout: a server without sign-in */
	serveUnauthenticated: "{{protocol}} has no sign-in. Anyone on this device can use the server while it runs.",
	/** Server page — read-only switch */
	serveReadOnly: "Read-only",
	/** Server page — read-only switch, description */
	serveReadOnlyDescription: "Clients can open files but not change them.",
	/** Server page — connect group heading */
	serveGroupConnect: "Connect",
	/** Server page — address clients connect to */
	serveUrl: "Address",
	/** Server page — address while the server is off */
	serveUrlOff: "Shown once the server is on.",
	/** Server page — accessible name of the copy button */
	serveUrlCopy: "Copy the address",
	/** Toast — the address was copied */
	serveUrlCopied: "Address copied",
	/** Server page — how-to row */
	serveHowTo: "How to connect",
	/** Connect hint — WebDAV */
	connectHintWebdav: 'Use a WebDAV client or your file manager\'s "Connect to server" with the user name and password below.',
	/** Connect hint — S3 */
	connectHintS3: "Use path-style requests with the access key below. Any region name works.",
	/** Connect hint — FTP */
	connectHintFtp: "Use an FTP client with the user name and password below.",
	/** Connect hint — SFTP */
	connectHintSftp: "Use an SFTP client with the user name and password below. Keys are not accepted.",
	/** Connect hint — HTTP */
	connectHintHttp: "Open the address in a browser to browse and download files, with the user name and password below.",
	/** Connect hint — restic */
	connectHintRestic: "Use the address as the restic repository, with the user name and password below.",
	/** Connect hint — NFS */
	connectHintNfs: "Mount the address with your system's NFS client.",
	/** HTTPS-off confirm — title */
	httpsOffTitle: "Turn off HTTPS?",
	/** HTTPS-off confirm — body */
	httpsOffBody:
		"The server listens on {{address}}. Without HTTPS, credentials travel in plain text and anyone on the network can read them and your files.",
	/** HTTPS-off confirm — confirm button */
	httpsOffConfirm: "Turn off",

	// ── Unauthenticated server dialog ───────────────────────────────────
	/** Dialog — title */
	unauthenticatedTitle: "Run the {{protocol}} server without sign-in?",
	/** Dialog — body */
	unauthenticatedBody:
		"{{protocol}} has no sign-in. While it runs, any app or user on this device can read and change your Filen drive through it.",
	/** Dialog — confirm button */
	unauthenticatedConfirm: "Run it",

	// ── Credentials ─────────────────────────────────────────────────────
	/** Credentials — group heading */
	serveGroupCredentials: "Credentials",
	/** Credentials — group description */
	serveCredentialsDescription: "Clients sign in with these. They are only for this server, never your Filen password.",
	/** Credential — user name */
	credentialUser: "User name",
	/** Credential — password */
	credentialPassword: "Password",
	/** Credential — S3 access key ID */
	credentialAccessKeyId: "Access key ID",
	/** Credential — S3 secret access key */
	credentialSecretAccessKey: "Secret access key",
	/** Credential — accessible name of a copy button; {{label}} is the credential's name */
	credentialCopy: "Copy {{label}}",
	/** Toast — a credential was copied */
	credentialCopied: "{{label}} copied",
	/** Credentials — reveal row */
	credentialsReveal: "Show credentials",
	/** Credentials — reveal row, description */
	credentialsRevealDescription: "Shown on this page until you leave it.",
	/** Credentials — reveal button */
	credentialsRevealAction: "Show",
	/** Credentials — accessible name of the hide button */
	credentialsHide: "Hide credentials",
	/** Credentials — hide button */
	credentialsHideAction: "Hide",
	/** Credentials — regenerate row */
	credentialsRegenerate: "Make new credentials",
	/** Credentials — regenerate row, description */
	credentialsRegenerateDescription: "Replaces them with new random ones.",
	/** Credentials — regenerate button */
	credentialsRegenerateAction: "Regenerate",
	/** Credentials — regenerate confirm title */
	credentialsRegenerateTitle: "Make new credentials?",
	/** Credentials — regenerate confirm body */
	credentialsRegenerateBody: "The current ones stop working. Clients using them must sign in with the new ones.",
	/** Toast — new credentials were made */
	credentialsRegeneratedToast: "New credentials made",
	/** Credentials — custom row */
	credentialsCustom: "Use your own credentials",
	/** Credentials — custom row, description */
	credentialsCustomRowDescription: "Pick the user name and password clients sign in with.",
	/** Credentials — custom button */
	credentialsCustomAction: "Set…",
	/** Custom credentials dialog — title */
	credentialsCustomTitle: "Use your own credentials",
	/** Custom credentials dialog — description */
	credentialsCustomDescription: "Clients using the current credentials must sign in with these.",
	/** Custom credentials dialog — description, S3 */
	credentialsCustomDescriptionS3:
		"Clients using the current keys must sign in with these. The access key ID is 16 to 128 letters and digits.",
	/** Custom credentials dialog — hint under the secret */
	credentialsCustomHint: 'At least 12 characters, not easy to guess, without ":" or ",".',
	/** Custom credentials dialog — save button */
	credentialsCustomSave: "Save",
	/** Toast — custom credentials saved */
	credentialsSaved: "Credentials saved",

	// ── Errors ──────────────────────────────────────────────────────────
	/** Error — the helper isn't running */
	errorHostUnavailable: "The Filen helper isn't running. Try again in a moment.",
	/** Error — nothing to mount with */
	errorFuseMissing: "The drive can't be mounted because the file system driver is missing.",
	/** Error — the mount point can't be used */
	errorMountPointInvalid: "That directory can't be the mount point.",
	/** Error — the mount point isn't empty */
	errorMountPointNotEmpty: "The mount point must be an empty directory.",
	/** Error — something is already mounted there */
	errorMountPointInUse: "Something is already mounted there.",
	/** Error — the drive letter is taken */
	errorDriveLetterInUse: "That drive letter is in use. Choose another one.",
	/** Error — the port is taken */
	errorPortInUse: "That port is in use. Choose another one.",
	/** Error — the address can't be listened on */
	errorAddressUnavailable: "The server can't listen on that address.",
	/** Error — the server needs credentials */
	errorAuthRequired: "The server needs credentials to run.",
	/** Error — uploads wait in the cache */
	errorUploadsPending: "Files are still waiting to upload. Try again once they're done.",
	/** Error — the protocol isn't offered here */
	errorUnsupportedProtocol: "This isn't available on this device.",
	/** Error — the bundled rclone is missing or damaged */
	errorBinaryInvalid: "Part of Filen is missing or damaged. Reinstall Filen.",
	/** Error — the session was rejected */
	errorUnauthenticated: "Your session has ended. Sign in again.",
	/** Error — no answer in time */
	errorTimeout: "That took too long. Try again.",
	/** Error — the chosen mount point is no longer valid */
	errorMountPointExpired: "That choice has expired. Choose the mount point again.",
	/** Error — credentials that can't be used */
	errorCredentialsInvalid: 'These credentials can\'t be used. Avoid ":" and ","; an S3 access key ID is 16 to 128 letters and digits.',
	/** Error — credentials that are too weak */
	errorCredentialsWeak: "That password is too easy to guess. Use at least 12 characters and avoid the user name.",
	/** Error — a server without sign-in needs the user's word */
	errorAcknowledgementRequired: "Confirm that the server may run without sign-in.",
	/** Error — anything else */
	errorUnknown: "Something went wrong. Try again.",

	// ── Mount point problems ────────────────────────────────────────────
	/** Problem — not a directory */
	problemNotDirectory: "It isn't a directory.",
	/** Problem — not empty */
	problemNotEmpty: "It isn't empty.",
	/** Problem — a symbolic link */
	problemSymlink: "It's a link to another location.",
	/** Problem — outside the home directory */
	problemOutsideHome: "It has to be inside your home directory.",
	/** Problem — the home directory itself */
	problemHomeDirectory: "It can't be your home directory itself.",
	/** Problem — app data */
	problemAppData: "It's inside Filen's own data.",
	/** Problem — temporary location */
	problemTemporary: "It's in a temporary location the system may empty.",
	/** Problem — inside a sync pair */
	problemInsidePair: "It's inside a synced directory.",
	/** Problem — contains a sync pair */
	problemContainsPair: "It contains a synced directory."
} as const
