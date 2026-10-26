import { type } from "arktype"
import type { DesktopMountsNotice, DesktopServeProtocol, DesktopVfsTuning } from "@filen/shared/desktop"
import {
	driveLetterSchema,
	listenHostSchema,
	localPathSchema,
	pinned,
	portSchema,
	SERVE_PROTOCOLS,
	vfsTuningSchema
} from "../../shared/nativeProtocol.ts"
import { type AtomicFile, errorCode } from "../atomicFile.ts"
import { serialQueue } from "../serial.ts"

// What the user set up for the network drive and the servers, per user. Credentials live apart, encrypted
// (credentials.ts); certificates are files beside them (tls.ts).

// `mountPoint` on macOS and Linux, `driveLetter` on Windows.
export interface MountsDrive {
	enabled: boolean
	mountPoint: string | null
	driveLetter: string | null
	readOnly: boolean
}

export interface MountsServe {
	enabled: boolean
	host: string
	port: number
	https: boolean
	readOnly: boolean
	// nfs has no authentication: it runs only once the user accepted that.
	acknowledgedUnauthenticated: boolean
}

export interface MountsConfig {
	version: 1
	drive: MountsDrive
	// A protocol never set up has no entry.
	serves: Partial<Record<DesktopServeProtocol, MountsServe>>
	tuning: DesktopVfsTuning
	// The old client's drive, WebDAV and S3 settings were applied for this user.
	legacyApplied: boolean
	notices: DesktopMountsNotice[]
}

export const DEFAULT_PORTS: Record<DesktopServeProtocol, number> = {
	webdav: 1900,
	s3: 1800,
	ftp: 2121,
	sftp: 2022,
	http: 1700,
	restic: 1600,
	nfs: 2049
}

// The old client's tuning.
export const DEFAULT_TUNING: DesktopVfsTuning = { cacheMaxGiB: 32, cacheMinFreeGiB: 16, cacheMaxAgeHours: 720, dirCacheSeconds: 15 }

export const DEFAULT_MOUNTS: MountsConfig = {
	version: 1,
	drive: { enabled: false, mountPoint: null, driveLetter: null, readOnly: false },
	serves: {},
	tuning: DEFAULT_TUNING,
	legacyApplied: false,
	notices: []
}

// Off, loopback, plain http.
export function defaultServe(protocol: DesktopServeProtocol): MountsServe {
	return {
		enabled: false,
		host: "127.0.0.1",
		port: DEFAULT_PORTS[protocol],
		https: false,
		readOnly: false,
		acknowledgedUnauthenticated: false
	}
}

export const mountsNoticeSchema = pinned<DesktopMountsNotice>()(
	type.enumerated(
		"credentialsRegenerated",
		"lanBindDisabled",
		"mountPointInvalid",
		"legacyUploadsPending",
		"legacyCacheErrored",
		"certificateRegenerated"
	)
)

const driveSchema = pinned<MountsDrive>()(
	type({
		enabled: "boolean",
		mountPoint: localPathSchema.or("null"),
		driveLetter: driveLetterSchema.or("null"),
		readOnly: "boolean",
		"+": "delete"
	})
)

const serveSchema = pinned<MountsServe>()(
	type({
		enabled: "boolean",
		host: listenHostSchema,
		port: portSchema,
		https: "boolean",
		readOnly: "boolean",
		acknowledgedUnauthenticated: "boolean",
		"+": "delete"
	})
)

const fileSchema = type({
	version: "1",
	drive: "unknown",
	serves: type({ "[string]": "unknown" }),
	tuning: "unknown",
	legacyApplied: "boolean",
	notices: "unknown[]",
	"+": "delete"
})

// A missing or unreadable file is the defaults; each part that does not validate falls back alone, so one bad entry
// never costs the others.
export function parseMountsConfig(data: string | null, warn: (message: string) => void): MountsConfig {
	if (data === null) {
		return DEFAULT_MOUNTS
	}

	let json: unknown

	try {
		json = JSON.parse(data)
	} catch {
		warn("mounts store is not JSON; starting with defaults")

		return DEFAULT_MOUNTS
	}

	const file = fileSchema(json)

	if (file instanceof type.errors) {
		warn("mounts store is invalid; starting with defaults")

		return DEFAULT_MOUNTS
	}

	const drive = driveSchema(file.drive)
	const tuning = vfsTuningSchema(file.tuning)
	const serves: MountsConfig["serves"] = {}

	for (const protocol of SERVE_PROTOCOLS) {
		const entry = file.serves[protocol]
		const serve = entry === undefined ? undefined : serveSchema(entry)

		if (serve instanceof type.errors) {
			warn(`dropping an invalid ${protocol} server record`)
		} else if (serve !== undefined) {
			serves[protocol] = serve
		}
	}

	if (drive instanceof type.errors) {
		warn("dropping an invalid network drive record")
	}

	if (tuning instanceof type.errors) {
		warn("dropping invalid mounts tuning")
	}

	return {
		version: 1,
		drive: drive instanceof type.errors ? DEFAULT_MOUNTS.drive : drive,
		serves,
		tuning: tuning instanceof type.errors ? DEFAULT_TUNING : tuning,
		legacyApplied: file.legacyApplied,
		notices: [
			...new Set(file.notices.filter((notice): notice is DesktopMountsNotice => !(mountsNoticeSchema(notice) instanceof type.errors)))
		]
	}
}

export function anyEnabled(config: MountsConfig): boolean {
	return config.drive.enabled || Object.values(config.serves).some(serve => serve.enabled)
}

export interface MountsStore {
	get(): MountsConfig
	// Applies `change` to the config in effect when its turn comes and resolves with the stored result. A failed write
	// rejects and keeps the config as it was.
	update(change: (config: MountsConfig) => MountsConfig): Promise<MountsConfig>
	// A role should run: the native host is wanted.
	anyEnabled(): boolean
}

// `<userData>/mounts/<userId>/mounts.json`; the caller creates the directory. Read once, served from memory. Writes
// run one at a time (they share the file's temp sibling).
export async function loadMountsStore(file: AtomicFile, warn: (message: string) => void): Promise<MountsStore> {
	let current = DEFAULT_MOUNTS
	const serial = serialQueue()

	try {
		current = parseMountsConfig((await file.read())?.toString("utf8") ?? null, warn)
	} catch (error) {
		warn(`mounts store unreadable: ${errorCode(error)}`)
	}

	return {
		get: () => current,
		update: change =>
			serial(async () => {
				const next = change(current)

				if (next !== current) {
					await file.write(Buffer.from(JSON.stringify(next)))
					current = next
				}

				return current
			}),
		anyEnabled: () => anyEnabled(current)
	}
}
