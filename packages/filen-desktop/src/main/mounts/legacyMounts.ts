import path from "node:path"
import { type } from "arktype"
import type { DesktopMountsNotice } from "@filen/shared/desktop"
import { listenHostSchema, localPathSchema, portSchema } from "../../shared/nativeProtocol.ts"
import { type CredentialProtocol, credentialsProblem, type ServeCredentials } from "./credentials.ts"
import { type MountPointContext, mountPointProblem } from "./mountPoint.ts"
import { DEFAULT_MOUNTS, defaultServe, type MountsConfig, type MountsDrive, type MountsServe } from "./store.ts"

// The old client's (3.x) network drive, WebDAV and S3 settings, as the migration stashed them. Live options carry over;
// cacheSizeInGi, cachePath, localDirPath, proxyMode and authMode are dropped. WIPE_SCRIPT already took the WebDAV
// password and S3 secret out of the old storage, so a stash made after it has none.

// Arrays are objects to arktype too.
const notArray = (value: object): boolean => !Array.isArray(value)

const driveSchema = type({ "enabled?": "boolean", "mountPoint?": "string", "readOnly?": "boolean", "+": "delete" }).narrow(notArray)

const webdavSchema = type({
	"enabled?": "boolean",
	"username?": "string",
	"password?": "string",
	"hostname?": "string",
	"port?": "number",
	"https?": "boolean",
	"+": "delete"
}).narrow(notArray)

const s3Schema = type({
	"enabled?": "boolean",
	"accessKeyId?": "string",
	"secretKeyId?": "string",
	"hostname?": "string",
	"port?": "number",
	"https?": "boolean",
	"+": "delete"
}).narrow(notArray)

// The user's effective config per feature (`effectiveConfig` of the stash).
export interface LegacyMountsInput {
	networkDrive?: unknown
	webdav?: unknown
	s3?: unknown
}

export interface LegacyMountsImport {
	// legacyApplied set, the notices to tell in it.
	config: MountsConfig
	// The credentials the servers keep; a server that gets new ones has none here (they are made when it starts).
	credentials: Partial<Record<CredentialProtocol, ServeCredentials>>
}

// "X", "X:" or "X:\" as the old client took a Windows mount point.
function driveLetterOf(mountPoint: string): string | null {
	const letter = /^([A-Za-z]):?\\?$/.exec(mountPoint)?.[1]?.toUpperCase()

	return letter !== undefined && letter >= "D" && letter <= "Z" ? letter : null
}

function importDrive(raw: unknown, ctx: MountPointContext, notices: Set<DesktopMountsNotice>): MountsDrive {
	const old = driveSchema(raw)

	if (old instanceof type.errors) {
		return DEFAULT_MOUNTS.drive
	}

	const enabled = old.enabled ?? false
	const readOnly = old.readOnly ?? false
	const mountPoint = old.mountPoint ?? ""

	if (ctx.platform === "win32") {
		const driveLetter = driveLetterOf(mountPoint)

		if (driveLetter === null && enabled) {
			notices.add("mountPointInvalid")
		}

		return { enabled: enabled && driveLetter !== null, mountPoint: null, driveLetter, readOnly }
	}

	// Only where it is: whether it exists and is empty is checked when it is mounted.
	const valid =
		path.posix.isAbsolute(mountPoint) &&
		mountPointProblem(path.posix.normalize(mountPoint), ctx, { directory: true, symlink: false, empty: true }) === null

	if (!valid && enabled) {
		notices.add("mountPointInvalid")
	}

	return { enabled: enabled && valid, mountPoint: valid ? path.posix.normalize(mountPoint) : null, driveLetter: null, readOnly }
}

// Where the old client mounted the drive, as it stored it (an invalid point included: a stale mount there still needs
// unmounting); null when it had none.
export function legacyDriveMountPoint(raw: unknown): string | null {
	const old = driveSchema(raw)

	if (old instanceof type.errors || old.mountPoint === undefined) {
		return null
	}

	return localPathSchema(old.mountPoint) instanceof type.errors ? null : old.mountPoint
}

interface OldServe {
	enabled: boolean
	hostname: string | undefined
	port: number | undefined
	https: boolean
	credentials: ServeCredentials | null
}

// The address this machine resolves a host name to, among its own; null when none (see createHostResolver).
export type HostResolver = (name: string) => Promise<string | null>

// An IP or localhost as it is; a host name as the local address it resolves to (the old client let rclone resolve it).
async function listenHostOf(hostname: string | undefined, resolveHost: HostResolver): Promise<string | null> {
	const host = listenHostSchema(hostname)

	if (!(host instanceof type.errors)) {
		return host
	}

	return hostname === undefined || hostname === "" ? null : resolveHost(hostname)
}

function importServe(
	protocol: CredentialProtocol,
	old: OldServe,
	host: string | null,
	notices: Set<DesktopMountsNotice>
): { serve: MountsServe; credentials: ServeCredentials | null } {
	const port = portSchema(old.port)
	const known = host !== null
	// Kept as they were, weak ones included; only ones the wipe took or rclone cannot take are made anew.
	const usable = old.credentials !== null && credentialsProblem(old.credentials) !== "invalid"

	if (old.enabled && !usable) {
		notices.add("credentialsRegenerated")
	}

	// No address of this machine.
	if (old.enabled && !known) {
		notices.add("addressInvalid")
	}

	if (old.enabled && old.https) {
		notices.add("certificateRegenerated")
	}

	return {
		serve: {
			...defaultServe(protocol),
			enabled: old.enabled && known,
			host: host ?? "127.0.0.1",
			port: port instanceof type.errors ? defaultServe(protocol).port : port,
			https: old.https
		},
		credentials: usable ? old.credentials : null
	}
}

// The new mounts config for the user from the old one. Pure: the migration writes the result and the credentials,
// then consumes the stash. Host names are resolved through `resolveHost`, which bounds its own wait.
export async function legacyMountsImport(
	effective: LegacyMountsInput,
	ctx: MountPointContext,
	resolveHost: HostResolver
): Promise<LegacyMountsImport> {
	const notices = new Set<DesktopMountsNotice>()
	const drive = importDrive(effective.networkDrive, ctx, notices)
	const serves: MountsConfig["serves"] = {}
	const credentials: LegacyMountsImport["credentials"] = {}
	const webdav = webdavSchema(effective.webdav)
	const s3 = s3Schema(effective.s3)
	const olds: [CredentialProtocol, OldServe | null][] = [
		[
			"webdav",
			webdav instanceof type.errors
				? null
				: {
						enabled: webdav.enabled ?? false,
						hostname: webdav.hostname,
						port: webdav.port,
						https: webdav.https ?? false,
						credentials:
							webdav.username === undefined || webdav.password === undefined
								? null
								: { kind: "basic", user: webdav.username, password: webdav.password }
					}
		],
		[
			"s3",
			s3 instanceof type.errors
				? null
				: {
						enabled: s3.enabled ?? false,
						hostname: s3.hostname,
						port: s3.port,
						https: s3.https ?? false,
						credentials:
							s3.accessKeyId === undefined || s3.secretKeyId === undefined
								? null
								: { kind: "s3", accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretKeyId }
					}
		]
	]

	const hosts = await Promise.all(olds.map(([, old]) => (old === null ? null : listenHostOf(old.hostname, resolveHost))))

	for (const [index, [protocol, old]] of olds.entries()) {
		if (old !== null) {
			const imported = importServe(protocol, old, hosts[index] ?? null, notices)

			serves[protocol] = imported.serve

			if (imported.credentials !== null) {
				credentials[protocol] = imported.credentials
			}
		}
	}

	return { config: { ...DEFAULT_MOUNTS, drive, serves, legacyApplied: true, notices: [...notices] }, credentials }
}
