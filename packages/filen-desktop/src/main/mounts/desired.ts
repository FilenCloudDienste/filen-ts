import type { DesktopServeProtocol } from "@filen/shared/desktop"
import {
	HTTPS_PROTOCOLS,
	isLoopbackHost,
	type NativeMountsDesired,
	type NativeServe,
	SERVE_PROTOCOLS
} from "../../shared/nativeProtocol.ts"
import { errorCode } from "../atomicFile.ts"
import type { CredentialStore } from "./credentials.ts"
import type { MountsConfig } from "./store.ts"
import type { ServeCertificate } from "./tls.ts"

export interface DesiredDeps {
	platform: NodeJS.Platform
	binary: NativeMountsDesired["binary"]
	stateDir: string
	cacheDir: string
	logFile: string | null
	credentials: CredentialStore
	// The certificate for an https server listening on `host`.
	certificate(protocol: DesktopServeProtocol, host: string): Promise<ServeCertificate>
	warn(message: string): void
}

// Whether the config asks for any role this platform can run; without one, nothing needs sending to a fresh host.
export function wantsRoles(config: MountsConfig, platform: NodeJS.Platform): boolean {
	return driveTarget(config, platform) !== null || SERVE_PROTOCOLS.some(protocol => runnable(config, protocol, platform))
}

function driveTarget(config: MountsConfig, platform: NodeJS.Platform): string | null {
	const { drive } = config

	if (!drive.enabled) {
		return null
	}

	return platform === "win32" ? (drive.driveLetter === null ? null : `${drive.driveLetter}:`) : drive.mountPoint
}

// nfs runs only on loopback, acknowledged, and never on Windows (it has no NFS server there).
function runnable(config: MountsConfig, protocol: DesktopServeProtocol, platform: NodeJS.Platform): boolean {
	const serve = config.serves[protocol]

	if (serve?.enabled !== true) {
		return false
	}

	return protocol !== "nfs" || (platform !== "win32" && serve.acknowledgedUnauthenticated && isLoopbackHost(serve.host))
}

// The state the native host should reach for `config`. A server whose credentials or certificate cannot be had now
// (a locked keychain) is left out and logged; the others still run.
export async function mountsDesired(config: MountsConfig, deps: DesiredDeps): Promise<NativeMountsDesired> {
	const mountPoint = driveTarget(config, deps.platform)
	const serves: NativeServe[] = []

	for (const protocol of SERVE_PROTOCOLS) {
		const serve = config.serves[protocol]

		if (serve === undefined || !runnable(config, protocol, deps.platform)) {
			continue
		}

		try {
			const auth = protocol === "nfs" ? { kind: "none" as const } : await deps.credentials.ensure(protocol)
			const certificate = serve.https && HTTPS_PROTOCOLS.has(protocol) ? await deps.certificate(protocol, serve.host) : null

			serves.push({
				protocol,
				host: serve.host,
				port: serve.port,
				auth,
				tls: certificate === null ? null : { cert: certificate.cert, key: certificate.key },
				readOnly: serve.readOnly
			})
		} catch (error) {
			deps.warn(`mounts: ${protocol} left out: ${errorCode(error)}`)
		}
	}

	return {
		binary: deps.binary,
		stateDir: deps.stateDir,
		cacheDir: deps.cacheDir,
		logFile: deps.logFile,
		tuning: config.tuning,
		drive: mountPoint === null ? null : { mountPoint, readOnly: config.drive.readOnly },
		serves
	}
}
