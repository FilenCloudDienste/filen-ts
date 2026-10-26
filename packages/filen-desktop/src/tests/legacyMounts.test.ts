import { describe, expect, it } from "vitest"
import { effectiveConfig, type LegacyStash } from "../main/legacyData.ts"
import { legacyDriveMountPoint, legacyMountsImport } from "../main/mounts/legacyMounts.ts"
import type { MountPointContext } from "../main/mounts/mountPoint.ts"
import { DEFAULT_MOUNTS, DEFAULT_TUNING, defaultServe } from "../main/mounts/store.ts"

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

const STRONG_S3 = { accessKeyId: "AKIA0123456789ABCDEF", secretKeyId: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" }

describe("legacyMountsImport", () => {
	it("defaults regenerated", () => {
		const { config, credentials } = legacyMountsImport({ webdav: OLD_WEBDAV, s3: OLD_S3 }, darwin)

		expect(credentials).toEqual({})
		expect(config.serves).toEqual({
			webdav: { ...defaultServe("webdav"), enabled: true },
			s3: { ...defaultServe("s3"), enabled: true }
		})
		expect(config.notices).toEqual(["credentialsRegenerated"])
		expect(config.legacyApplied).toBe(true)
		expect(config.tuning).toEqual(DEFAULT_TUNING)
	})

	it("disabled defaults are dropped quietly", () => {
		const { config, credentials } = legacyMountsImport({ webdav: { ...OLD_WEBDAV, enabled: false } }, darwin)

		expect(credentials).toEqual({})
		expect(config.serves.webdav?.enabled).toBe(false)
		expect(config.notices).toEqual([])
	})

	it("strong custom credentials kept", () => {
		const { config, credentials } = legacyMountsImport(
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
		// A LAN bind with strong credentials keeps running.
		expect(config.serves.s3).toEqual({ ...defaultServe("s3"), enabled: true, host: "192.168.1.20" })
		expect(config.notices).toEqual(["certificateRegenerated"])
	})

	it("LAN with defaults never auto-starts", () => {
		const { config } = legacyMountsImport(
			{
				webdav: { ...OLD_WEBDAV, hostname: "0.0.0.0" },
				s3: { ...OLD_S3, hostname: "my-mac.local" }
			},
			darwin
		)

		expect(config.serves.webdav).toEqual({ ...defaultServe("webdav"), host: "0.0.0.0" })
		expect(config.serves.s3).toEqual(defaultServe("s3"))
		expect(config.notices).toEqual(["credentialsRegenerated", "lanBindDisabled"])
	})

	it("a stash taken after the wipe has no secrets: new ones are made", () => {
		const { password: _password, ...withoutPassword } = OLD_WEBDAV
		const { config, credentials } = legacyMountsImport({ webdav: { ...withoutPassword, username: "alice" } }, darwin)

		expect(credentials).toEqual({})
		expect(config.serves.webdav?.enabled).toBe(true)
		expect(config.notices).toEqual(["credentialsRegenerated"])
	})

	it("/tmp/filen disables the drive", () => {
		expect(legacyMountsImport({ networkDrive: { ...OLD_DRIVE, mountPoint: "/tmp/filen" } }, darwin).config).toMatchObject({
			drive: { enabled: false, mountPoint: null, driveLetter: null, readOnly: true },
			notices: ["mountPointInvalid"]
		})
		expect(legacyMountsImport({ networkDrive: { ...OLD_DRIVE, mountPoint: "Filen" } }, darwin).config.notices).toEqual([
			"mountPointInvalid"
		])
		// Never used: nothing to tell.
		expect(legacyMountsImport({ networkDrive: { ...OLD_DRIVE, enabled: false, mountPoint: "/tmp/filen" } }, darwin).config).toEqual({
			...DEFAULT_MOUNTS,
			drive: { ...DEFAULT_MOUNTS.drive, readOnly: true },
			legacyApplied: true
		})
	})

	it("keeps a drive under home and a Windows letter", () => {
		expect(legacyMountsImport({ networkDrive: OLD_DRIVE }, darwin).config.drive).toEqual({
			enabled: true,
			mountPoint: "/Users/u/Filen",
			driveLetter: null,
			readOnly: true
		})
		expect(legacyMountsImport({ networkDrive: { ...OLD_DRIVE, mountPoint: "X:" } }, win32).config.drive).toEqual({
			enabled: true,
			mountPoint: null,
			driveLetter: "X",
			readOnly: true
		})
		expect(legacyMountsImport({ networkDrive: { ...OLD_DRIVE, mountPoint: "C:" } }, win32).config).toMatchObject({
			drive: { enabled: false, driveLetter: null },
			notices: ["mountPointInvalid"]
		})
	})

	it("effective config fallback only for the stashed user", () => {
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

		expect(legacyMountsImport(input("1001"), darwin).config.serves.webdav?.port).toBe(1001)
		expect(legacyMountsImport(input("1001"), darwin).config.drive.enabled).toBe(true)
		expect(legacyMountsImport(input("2002"), darwin).config.serves.webdav?.port).toBe(2002)
		expect(legacyMountsImport(input("2002"), darwin).config.drive).toEqual(DEFAULT_MOUNTS.drive)
		expect(legacyMountsImport(input("3003"), darwin).config).toEqual({ ...DEFAULT_MOUNTS, legacyApplied: true })
	})

	it("ignores sections of another shape", () => {
		expect(legacyMountsImport({ networkDrive: "x", webdav: [1], s3: { port: "1800" } }, darwin).config).toEqual({
			...DEFAULT_MOUNTS,
			legacyApplied: true
		})
	})
})

describe("legacyDriveMountPoint", () => {
	it("is the stored point, an invalid one included", () => {
		expect(legacyDriveMountPoint(OLD_DRIVE)).toBe("/Users/u/Filen")
		expect(legacyDriveMountPoint({ mountPoint: "/tmp/filen" })).toBe("/tmp/filen")
		expect(legacyDriveMountPoint({ mountPoint: "X:" })).toBe("X:")
		expect(legacyDriveMountPoint({ mountPoint: "" })).toBeNull()
		expect(legacyDriveMountPoint({ enabled: true })).toBeNull()
		expect(legacyDriveMountPoint(["/x"])).toBeNull()
		expect(legacyDriveMountPoint(undefined)).toBeNull()
	})
})
