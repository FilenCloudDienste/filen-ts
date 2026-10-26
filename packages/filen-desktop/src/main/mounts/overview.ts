import type {
	DesktopDrive,
	DesktopFuseStatus,
	DesktopMountsError,
	DesktopMountsOverview,
	DesktopMountsRole,
	DesktopMountsRoleState,
	DesktopServe,
	DesktopServeProtocol,
	DesktopSyncHostState
} from "@filen/shared/desktop"
import { HTTPS_PROTOCOLS, type NativeMountsStatus, SERVE_PROTOCOLS } from "../../shared/nativeProtocol.ts"
import { listenAddressKind } from "./addresses.ts"
import { defaultServe, type MountsConfig } from "./store.ts"

// nfs has no server on Windows.
export function offeredProtocols(platform: NodeJS.Platform): DesktopServeProtocol[] {
	return SERVE_PROTOCOLS.filter(protocol => protocol !== "nfs" || platform !== "win32")
}

// What a client connects to. A server on every interface is reached here through loopback.
export function serveUrl(protocol: DesktopServeProtocol, host: string, port: number, https: boolean): string {
	const address = host === "0.0.0.0" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host
	const web = `${https && HTTPS_PROTOCOLS.has(protocol) ? "https" : "http"}://${address}:${String(port)}`

	switch (protocol) {
		case "ftp":
		case "sftp":
		case "nfs":
			return `${protocol}://${address}:${String(port)}`
		case "restic":
			return `rest:${web}/`
		default:
			return web
	}
}

export interface MountsOverviewInput {
	host: DesktopSyncHostState
	available: boolean
	fuse: DesktopFuseStatus | null
	fuseGap: DesktopMountsOverview["fuseGap"]
	config: MountsConfig
	// What the host last reported; null while no host runs for the user.
	status: NativeMountsStatus | null
	// The last mountsApply failed as a whole.
	applyError: DesktopMountsError | null
	cache: { usedBytes: number; freeBytes: number } | null
	fingerprints: ReadonlyMap<DesktopServeProtocol, string>
	platform: NodeJS.Platform
}

interface RoleView {
	state: DesktopMountsRoleState
	error: DesktopMountsError | null
}

function roleView(input: MountsOverviewInput, role: DesktopMountsRole, enabled: boolean): RoleView {
	const reported = input.status?.roles.find(entry => entry.role === role)

	if (reported !== undefined) {
		return { state: reported.state, error: reported.error }
	}

	if (!enabled) {
		return { state: "off", error: null }
	}

	if (!input.available) {
		return { state: "error", error: { code: "binaryInvalid" } }
	}

	if (input.applyError !== null) {
		return { state: "error", error: input.applyError }
	}

	const { state } = input.host

	return { state: state === "running" || state === "starting" || state === "restarting" ? "starting" : "off", error: null }
}

// Where the drive is mounted now, from the target the host was sent ("X:" on Windows); null while it is not.
export function mountedDrive(target: string | null, status: NativeMountsStatus | null, platform: NodeJS.Platform): string | null {
	const running = status?.roles.some(role => role.role === "drive" && role.state === "running") === true

	if (!running || target === null) {
		return null
	}

	return platform === "win32" ? `${target}\\` : target
}

export function mountsOverview(input: MountsOverviewInput): DesktopMountsOverview {
	const { config, platform } = input
	const windows = platform === "win32"
	const drive: DesktopDrive = {
		enabled: config.drive.enabled,
		...roleView(input, "drive", config.drive.enabled),
		mountPoint: windows ? null : config.drive.mountPoint,
		driveLetter: windows ? config.drive.driveLetter : null,
		readOnly: config.drive.readOnly
	}
	const protocols = offeredProtocols(platform)
	const serves = protocols.map((protocol): DesktopServe => {
		const serve = config.serves[protocol] ?? defaultServe(protocol)
		const httpsCapable = HTTPS_PROTOCOLS.has(protocol)
		const https = serve.https && httpsCapable

		return {
			protocol,
			enabled: serve.enabled,
			...roleView(input, protocol, serve.enabled),
			address: serve.host,
			addressKind: listenAddressKind(serve.host),
			port: serve.port,
			httpsCapable,
			https,
			readOnly: serve.readOnly,
			authenticated: protocol !== "nfs",
			url: serve.enabled ? serveUrl(protocol, serve.host, serve.port, https) : null,
			tlsFingerprint: https ? (input.fingerprints.get(protocol) ?? null) : null
		}
	})

	return {
		host: input.host,
		available: input.available,
		fuse: input.fuse,
		fuseGap: input.fuseGap,
		drive,
		serves,
		protocols,
		cache: {
			usedBytes: input.cache?.usedBytes ?? 0,
			freeBytes: input.cache?.freeBytes ?? 0,
			pendingUploads: input.status?.uploads?.pending ?? 0,
			erroredFiles: input.status?.uploads?.errored ?? 0
		},
		tuning: config.tuning,
		notices: config.notices
	}
}
