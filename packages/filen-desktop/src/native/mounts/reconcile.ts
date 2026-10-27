import type { MountOptions, ServeAuth, ServeOptions, VfsTuning } from "@filen/sdk-rs"
import type { DesktopMountsRole, DesktopServeProtocol, DesktopVfsTuning } from "@filen/shared/desktop"
import type { NativeMountsDesired, NativeServe } from "../../shared/nativeProtocol.ts"
import type { NativeSdk } from "../addon.ts"

const GIB = 1024n ** 3n

export function vfsTuning(tuning: DesktopVfsTuning): VfsTuning {
	return {
		cacheMaxSize: BigInt(tuning.cacheMaxGiB) * GIB,
		cacheMinFreeSpace: BigInt(tuning.cacheMinFreeGiB) * GIB,
		cacheMaxAgeSecs: BigInt(tuning.cacheMaxAgeHours) * 3600n,
		dirCacheTimeSecs: tuning.dirCacheSeconds
	}
}

export type RoleSpec = { kind: "drive"; options: MountOptions } | { kind: "serve"; serve: NativeServe }

// A role the desired state names, with the key that tells a changed role from an unchanged one. The key holds the
// serve's credentials: it stays in this process's memory and is never logged.
export interface WantedRole {
	role: DesktopMountsRole
	key: string
	spec: RoleSpec
}

export function wantedRoles(desired: NativeMountsDesired): Map<DesktopMountsRole, WantedRole> {
	const wanted = new Map<DesktopMountsRole, WantedRole>()

	if (desired.drive !== null) {
		const options = { mountPoint: desired.drive.mountPoint, readOnly: desired.drive.readOnly }

		wanted.set("drive", { role: "drive", key: JSON.stringify(options), spec: { kind: "drive", options } })
	}

	for (const serve of desired.serves) {
		wanted.set(serve.protocol, { role: serve.protocol, key: JSON.stringify(serve), spec: { kind: "serve", serve } })
	}

	return wanted
}

// What the daemon itself is started with; a change to any of it (the tuning among them) restarts it with every role.
export function daemonKey(desired: NativeMountsDesired): string {
	const { binary, stateDir, cacheDir, logFile, tuning } = desired

	return JSON.stringify({ binary, stateDir, cacheDir, logFile, tuning })
}

function serveProtocol(sdk: NativeSdk, protocol: DesktopServeProtocol): ServeOptions["protocol"] {
	switch (protocol) {
		case "webdav":
			return sdk.ServeProtocol.Webdav
		case "s3":
			return sdk.ServeProtocol.S3
		case "ftp":
			return sdk.ServeProtocol.Ftp
		case "sftp":
			return sdk.ServeProtocol.Sftp
		case "http":
			return sdk.ServeProtocol.Http
		case "restic":
			return sdk.ServeProtocol.Restic
		case "nfs":
			return sdk.ServeProtocol.Nfs
	}
}

function serveAuth(auth: NativeServe["auth"]): ServeAuth {
	switch (auth.kind) {
		case "basic":
			return { tag: "Basic", inner: { user: auth.user, password: auth.password } }
		case "s3":
			return { tag: "S3", inner: { accessKeyId: auth.accessKeyId, secretAccessKey: auth.secretAccessKey } }
		case "none":
			return { tag: "Unauthenticated" }
	}
}

export function serveOptions(sdk: NativeSdk, serve: NativeServe): ServeOptions {
	const options: ServeOptions = {
		protocol: serveProtocol(sdk, serve.protocol),
		host: serve.host,
		port: serve.port,
		auth: serveAuth(serve.auth),
		readOnly: serve.readOnly
	}

	if (serve.tls !== null) {
		options.tls = { certPath: serve.tls.cert, keyPath: serve.tls.key }
	}

	return options
}
