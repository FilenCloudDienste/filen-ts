import { describe, expect, it, vi } from "vitest"
import { effectiveConfig, type LegacyStash } from "../main/legacyData.ts"
import { type HostResolver, legacyDriveMountPoint, legacyMountsImport, type LegacyMountsInput } from "../main/mounts/legacyMounts.ts"
import type { MountPointContext } from "../main/mounts/mountPoint.ts"
import { createHostResolver, type HostLookup } from "../main/mounts/addresses.ts"
import { DEFAULT_MOUNTS, defaultServe } from "../main/mounts/store.ts"
import { DEFAULT_TUNING } from "../shared/nativeProtocol.ts"

const darwin: MountPointContext = {
	platform: "darwin",
	home: "/Users/u",
	appData: ["/Users/u/Library/Application Support/@filen/desktop"],
	temporary: ["/private/var/folders/ab/xyz/T", "/private/tmp", "/tmp"],
	pairRoots: []
}

const win32: MountPointContext = { platform: "win32", home: "C:\\Users\\u", appData: [], temporary: [], pairRoots: [] }

// The old client's defaults.
const OLD_WEBDAV = {
	enabled: true,
	username: "admin",
	password: "admin",
	hostname: "127.0.0.1",
	port: 1900,
	proxyMode: false,
	https: false,
	authMode: "basic"
}
const OLD_S3 = { enabled: true, accessKeyId: "admin", secretKeyId: "admin", hostname: "127.0.0.1", port: 1800, https: false }
const OLD_DRIVE = { enabled: true, mountPoint: "/Users/u/Filen", localDirPath: "/x/networkDrive", cacheSizeInGi: 10, readOnly: true }

const unresolved: HostResolver = () => Promise.resolve(null)

function importOld(input: LegacyMountsInput, ctx: MountPointContext, resolveHost = unresolved) {
	return legacyMountsImport(input, ctx, resolveHost)
}

const STRONG_S3 = { accessKeyId: "AKIA0123456789ABCDEF", secretKeyId: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" }

describe("legacyMountsImport", () => {
	it("old credentials kept as they were, weak and default ones included", async () => {
		const { config, credentials } = await importOld(
			{ webdav: OLD_WEBDAV, s3: { ...OLD_S3, accessKeyId: "adminadminadmin1", secretKeyId: "adminadminadmin1" } },
			darwin
		)

		expect(credentials).toEqual({
			webdav: { kind: "basic", user: "admin", password: "admin" },
			s3: { kind: "s3", accessKeyId: "adminadminadmin1", secretAccessKey: "adminadminadmin1" }
		})
		expect(config.serves).toEqual({
			webdav: { ...defaultServe("webdav"), enabled: true },
			s3: { ...defaultServe("s3"), enabled: true }
		})
		expect(config.notices).toEqual([])
		expect(config.legacyApplied).toBe(true)
		expect(config.tuning).toEqual(DEFAULT_TUNING)
	})

	it("s3 credentials rclone cannot take are made anew", async () => {
		const { config, credentials } = await importOld({ webdav: OLD_WEBDAV, s3: OLD_S3 }, darwin)

		expect(credentials).toEqual({ webdav: { kind: "basic", user: "admin", password: "admin" } })
		expect(config.serves.s3).toEqual({ ...defaultServe("s3"), enabled: true })
		expect(config.notices).toEqual(["credentialsRegenerated"])
	})

	it("a disabled server is imported quietly", async () => {
		const { config, credentials } = await importOld(
			{ webdav: { ...OLD_WEBDAV, enabled: false }, s3: { ...OLD_S3, enabled: false } },
			darwin
		)

		expect(credentials).toEqual({ webdav: { kind: "basic", user: "admin", password: "admin" } })
		expect(config.serves.webdav?.enabled).toBe(false)
		expect(config.notices).toEqual([])
	})

	it("strong custom credentials kept", async () => {
		const { config, credentials } = await importOld(
			{
				webdav: { ...OLD_WEBDAV, username: "alice", password: "correct horse battery staple", port: 8080, https: true },
				s3: { ...OLD_S3, ...STRONG_S3, hostname: "192.168.1.20" }
			},
			darwin
		)

		expect(credentials).toEqual({
			webdav: { kind: "basic", user: "alice", password: "correct horse battery staple" },
			s3: { kind: "s3", accessKeyId: STRONG_S3.accessKeyId, secretAccessKey: STRONG_S3.secretKeyId }
		})
		expect(config.serves.webdav).toEqual({ ...defaultServe("webdav"), enabled: true, port: 8080, https: true })
		expect(config.serves.s3).toEqual({ ...defaultServe("s3"), enabled: true, host: "192.168.1.20" })
		expect(config.notices).toEqual(["certificateRegenerated"])
	})

	it("a LAN bind with default credentials keeps running", async () => {
		const { config, credentials } = await importOld({ webdav: { ...OLD_WEBDAV, hostname: "0.0.0.0" } }, darwin)

		expect(credentials).toEqual({ webdav: { kind: "basic", user: "admin", password: "admin" } })
		expect(config.serves.webdav).toEqual({ ...defaultServe("webdav"), enabled: true, host: "0.0.0.0" })
		expect(config.notices).toEqual([])
	})

	it("a host name resolved to an address of this machine keeps running there", async () => {
		const resolveHost = vi.fn<HostResolver>(() => Promise.resolve("192.168.1.20"))
		const { config, credentials } = await importOld(
			{ webdav: { ...OLD_WEBDAV, hostname: "my-mac.local", port: 8080, https: true } },
			darwin,
			resolveHost
		)

		expect(resolveHost).toHaveBeenCalledExactlyOnceWith("my-mac.local")
		expect(credentials).toEqual({ webdav: { kind: "basic", user: "admin", password: "admin" } })
		expect(config.serves.webdav).toEqual({ ...defaultServe("webdav"), enabled: true, host: "192.168.1.20", port: 8080, https: true })
		expect(config.notices).toEqual(["certificateRegenerated"])
	})

	it("a host name that resolves to no address of this machine turns the server off", async () => {
		const { config, credentials } = await importOld({ webdav: { ...OLD_WEBDAV, hostname: "my-mac.local" } }, darwin)

		expect(credentials).toEqual({ webdav: { kind: "basic", user: "admin", password: "admin" } })
		expect(config.serves.webdav).toEqual(defaultServe("webdav"))
		expect(config.notices).toEqual(["addressInvalid"])
	})

	it("IP addresses are not resolved", async () => {
		const resolveHost = vi.fn<HostResolver>(() => Promise.resolve(null))

		await importOld({ webdav: { ...OLD_WEBDAV, hostname: "0.0.0.0" }, s3: { ...OLD_S3, hostname: "localhost" } }, darwin, resolveHost)
		expect(resolveHost).not.toHaveBeenCalled()
	})

	it("a stash taken after the wipe has no secrets: new ones are made", async () => {
		const { password: _password, ...withoutPassword } = OLD_WEBDAV
		const { config, credentials } = await importOld({ webdav: { ...withoutPassword, username: "alice" } }, darwin)

		expect(credentials).toEqual({})
		expect(config.serves.webdav?.enabled).toBe(true)
		expect(config.notices).toEqual(["credentialsRegenerated"])
	})

	it("/tmp/filen disables the drive", async () => {
		expect((await importOld({ networkDrive: { ...OLD_DRIVE, mountPoint: "/tmp/filen" } }, darwin)).config).toMatchObject({
			drive: { enabled: false, mountPoint: null, driveLetter: null, readOnly: true },
			notices: ["mountPointInvalid"]
		})
		expect((await importOld({ networkDrive: { ...OLD_DRIVE, mountPoint: "Filen" } }, darwin)).config.notices).toEqual([
			"mountPointInvalid"
		])
		// Never used: nothing to tell.
		expect((await importOld({ networkDrive: { ...OLD_DRIVE, enabled: false, mountPoint: "/tmp/filen" } }, darwin)).config).toEqual({
			...DEFAULT_MOUNTS,
			drive: { ...DEFAULT_MOUNTS.drive, readOnly: true },
			legacyApplied: true
		})
	})

	it("keeps a drive under home and a Windows letter", async () => {
		expect((await importOld({ networkDrive: OLD_DRIVE }, darwin)).config.drive).toEqual({
			enabled: true,
			mountPoint: "/Users/u/Filen",
			driveLetter: null,
			readOnly: true
		})
		expect((await importOld({ networkDrive: { ...OLD_DRIVE, mountPoint: "X:" } }, win32)).config.drive).toEqual({
			enabled: true,
			mountPoint: null,
			driveLetter: "X",
			readOnly: true
		})
		expect((await importOld({ networkDrive: { ...OLD_DRIVE, mountPoint: "C:" } }, win32)).config).toMatchObject({
			drive: { enabled: false, driveLetter: null },
			notices: ["mountPointInvalid"]
		})
	})

	it("effective config fallback only for the stashed user", async () => {
		const stash: LegacyStash = {
			version: 1,
			userId: 1001,
			users: { sync: {}, networkDrive: {}, webdav: { "2002": { ...OLD_WEBDAV, port: 2002 } }, s3: {} },
			fallback: { webdav: { ...OLD_WEBDAV, port: 1001 }, networkDrive: OLD_DRIVE }
		}
		const input = (userId: string) => ({
			networkDrive: effectiveConfig(stash, userId, "networkDrive"),
			webdav: effectiveConfig(stash, userId, "webdav"),
			s3: effectiveConfig(stash, userId, "s3")
		})

		expect((await importOld(input("1001"), darwin)).config.serves.webdav?.port).toBe(1001)
		expect((await importOld(input("1001"), darwin)).config.drive.enabled).toBe(true)
		expect((await importOld(input("2002"), darwin)).config.serves.webdav?.port).toBe(2002)
		expect((await importOld(input("2002"), darwin)).config.drive).toEqual(DEFAULT_MOUNTS.drive)
		expect((await importOld(input("3003"), darwin)).config).toEqual({ ...DEFAULT_MOUNTS, legacyApplied: true })
	})

	it("ignores sections of another shape", async () => {
		expect((await importOld({ networkDrive: "x", webdav: [1], s3: { port: "1800" } }, darwin)).config).toEqual({
			...DEFAULT_MOUNTS,
			legacyApplied: true
		})
	})
})

describe("legacyDriveMountPoint", async () => {
	it("is the stored point, an invalid one included", async () => {
		expect(legacyDriveMountPoint(OLD_DRIVE)).toBe("/Users/u/Filen")
		expect(legacyDriveMountPoint({ mountPoint: "/tmp/filen" })).toBe("/tmp/filen")
		expect(legacyDriveMountPoint({ mountPoint: "X:" })).toBe("X:")
		expect(legacyDriveMountPoint({ mountPoint: "" })).toBeNull()
		expect(legacyDriveMountPoint({ enabled: true })).toBeNull()
		expect(legacyDriveMountPoint(["/x"])).toBeNull()
		expect(legacyDriveMountPoint(undefined)).toBeNull()
	})
})

describe("createHostResolver", () => {
	const interfaces = () =>
		({
			lo0: [
				{
					address: "127.0.0.1",
					netmask: "255.0.0.0",
					family: "IPv4",
					mac: "00:00:00:00:00:00",
					internal: true,
					cidr: "127.0.0.1/8"
				}
			],
			en0: [
				{
					address: "192.168.1.20",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "192.168.1.20/24"
				}
			]
		}) satisfies ReturnType<HostLookup["interfaces"]>
	const resolver = (lookup: HostLookup["lookup"], timeoutMs = 3000) => createHostResolver({ lookup, interfaces, timeoutMs })

	it("picks the address of this machine", async () => {
		const resolve = resolver(() =>
			Promise.resolve([
				{ address: "fe80::1", family: 6 },
				{ address: "192.168.1.20", family: 4 }
			])
		)

		expect(await resolve("my-mac.local")).toBe("192.168.1.20")
		expect(await resolver(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }]))("my-mac")).toBe("127.0.0.1")
	})

	it("is null for another machine's address, a failed lookup or a slow one", async () => {
		expect(await resolver(() => Promise.resolve([{ address: "192.168.1.99", family: 4 }]))("nas.local")).toBeNull()
		expect(await resolver(() => Promise.resolve([{ address: "0.0.0.0", family: 4 }]))("any")).toBeNull()
		expect(await resolver(() => Promise.reject(new Error("ENOTFOUND")))("gone.local")).toBeNull()

		vi.useFakeTimers()

		try {
			const pending = resolver(() => new Promise(() => undefined), 3000)("slow.local")

			await vi.advanceTimersByTimeAsync(3000)
			expect(await pending).toBeNull()
		} finally {
			vi.useRealTimers()
		}
	})
})
