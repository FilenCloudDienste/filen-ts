import { describe, expect, it, vi } from "vitest"
import { listenAddresses } from "../main/mounts/addresses.ts"
import { createCredentialStore } from "../main/mounts/credentials.ts"
import { mountsDesired, wantsRoles } from "../main/mounts/desired.ts"
import { DEFAULT_MOUNTS, defaultServe, type MountsConfig } from "../main/mounts/store.ts"
import { codedError } from "../main/atomicFile.ts"
import { toNativeSchema } from "../shared/nativeProtocol.ts"
import { fakeCipher, memoryFile } from "./fileFakes.ts"

function deps(platform: NodeJS.Platform = "darwin") {
	return {
		platform,
		binary: { path: "/app/rclone", sha256: null },
		stateDir: "/data/state",
		cacheDir: "/data/cache",
		logFile: null,
		credentials: createCredentialStore(memoryFile(), () => Promise.resolve(fakeCipher()), vi.fn()),
		certificate: vi.fn((protocol: string) =>
			Promise.resolve({ cert: `/tls/${protocol}.crt`, key: `/tls/${protocol}.key`, fingerprint: "AA" })
		),
		warn: vi.fn()
	}
}

const CONFIG: MountsConfig = {
	...DEFAULT_MOUNTS,
	drive: { enabled: true, mountPoint: "/Users/u/Filen", driveLetter: "X", readOnly: true },
	serves: {
		webdav: { ...defaultServe("webdav"), enabled: true, https: true },
		s3: { ...defaultServe("s3"), enabled: true },
		ftp: { ...defaultServe("ftp"), enabled: false },
		nfs: { ...defaultServe("nfs"), enabled: true, acknowledgedUnauthenticated: true }
	}
}

describe("mountsDesired", () => {
	it("sends every enabled role with its credentials and certificate", async () => {
		const desired = await mountsDesired(CONFIG, deps())

		expect(desired.drive).toEqual({ mountPoint: "/Users/u/Filen", readOnly: true })
		expect(desired.serves.map(serve => [serve.protocol, serve.auth.kind, serve.tls?.cert ?? null])).toEqual([
			["webdav", "basic", "/tls/webdav.crt"],
			["s3", "s3", null],
			["nfs", "none", null]
		])
		expect(toNativeSchema.allows({ t: "call", id: 1, op: "mountsApply", args: { desired } })).toBe(true)
	})

	it("Windows mounts on the letter and runs no nfs", async () => {
		const desired = await mountsDesired(CONFIG, deps("win32"))

		expect(desired.drive).toEqual({ mountPoint: "X:", readOnly: true })
		expect(desired.serves.map(serve => serve.protocol)).toEqual(["webdav", "s3"])
	})

	it("nfs needs the acknowledgement and loopback", async () => {
		const nfs = (patch: object) => ({ ...DEFAULT_MOUNTS, serves: { nfs: { ...defaultServe("nfs"), enabled: true, ...patch } } })

		expect(wantsRoles(nfs({ acknowledgedUnauthenticated: true }), "linux")).toBe(true)
		expect(wantsRoles(nfs({}), "linux")).toBe(false)
		expect(wantsRoles(nfs({ acknowledgedUnauthenticated: true, host: "192.168.1.20" }), "linux")).toBe(false)
		expect(wantsRoles(DEFAULT_MOUNTS, "linux")).toBe(false)
	})

	it("a server without credentials now is left out, the rest still run", async () => {
		const options = deps()

		options.credentials.ensure = () => Promise.reject(codedError("credentialsUnreadable"))

		const desired = await mountsDesired(CONFIG, options)

		expect(desired.serves.map(serve => serve.protocol)).toEqual(["nfs"])
		expect(desired.drive).not.toBeNull()
		expect(options.warn).toHaveBeenCalledWith("mounts: webdav left out: credentialsUnreadable")
	})
})

describe("listenAddresses", () => {
	it("loopback, the external IPv4 addresses, then every interface", () => {
		expect(
			listenAddresses({
				lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: null }],
				en0: [
					{ address: "fe80::1", netmask: "ffff::", family: "IPv6", mac: "", internal: false, cidr: null, scopeid: 4 },
					{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: null }
				],
				en1: undefined
			})
		).toEqual([
			{ address: "127.0.0.1", kind: "loopback", interface: null },
			{ address: "192.168.1.20", kind: "lan", interface: "en0" },
			{ address: "0.0.0.0", kind: "all", interface: null }
		])
	})
})
