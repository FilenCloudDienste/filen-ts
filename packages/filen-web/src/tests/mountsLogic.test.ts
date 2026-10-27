import { describe, expect, it } from "vitest"
import { type } from "arktype"
import type { DesktopListenAddress, DesktopMountsOverview, DesktopServe } from "@filen/shared/desktop"
import { mounts } from "@/locales/en/mounts"
import { MOUNT_POINT_PROBLEM_KEY, MOUNT_POINT_PROBLEMS, MOUNTS_ERROR_KEY, mountsErrorKey } from "@/features/mounts/lib/mountsErrors.logic"
import {
	ADDRESS_KIND_KEY,
	addressChoices,
	aggregateMountsState,
	CONNECT_HINT_KEY,
	credentialLabels,
	driveReadOnlyLocked,
	enableNeedsAcknowledgement,
	FUSE_GAP_KEY,
	FUSE_INSTALL_KEY,
	FUSE_PROVIDER_KEY,
	httpsOffNeedsWarning,
	NOTICE_KEY,
	NOTICE_SCOPE,
	portInput,
	ROLE_STATE_KEY,
	roleStateKey,
	sendsPlainText,
	tuningInput
} from "@/features/mounts/lib/mountsStatus.logic"
import { hostBanner } from "@/features/desktop/lib/hostBanner.logic"
import { PROTOCOL_LABEL_KEY, SERVE_PROTOCOLS } from "@/features/mounts/lib/mountsRoles"

const CATALOG: Record<string, string> = mounts

function expectAllKeysExist(map: Record<string, string>, members: readonly string[]): void {
	expect(Object.keys(map).sort()).toEqual([...members].sort())

	for (const [member, key] of Object.entries(map)) {
		expect(CATALOG[key], `${member} → ${key}`).toBeTypeOf("string")
	}
}

const ERROR_CODES = [
	"hostUnavailable",
	"fuseMissing",
	"mountPointInvalid",
	"mountPointNotEmpty",
	"mountPointInUse",
	"driveLetterInUse",
	"portInUse",
	"addressUnavailable",
	"authRequired",
	"uploadsPending",
	"unsupportedProtocol",
	"binaryInvalid",
	"unauthenticated",
	"timeout",
	"mountPointExpired",
	"credentialsInvalid",
	"credentialsWeak",
	"acknowledgementRequired",
	"unknown"
]

const SERVE: DesktopServe = {
	protocol: "webdav",
	enabled: true,
	state: "running",
	address: "127.0.0.1",
	addressKind: "loopback",
	port: 1900,
	httpsCapable: true,
	https: false,
	readOnly: false,
	authenticated: true,
	url: "http://127.0.0.1:1900",
	tlsFingerprint: null,
	error: null
}

function overview(patch: Partial<DesktopMountsOverview> = {}): DesktopMountsOverview {
	return {
		host: { state: "running" },
		available: true,
		fuse: { state: "ready", provider: "fuse3" },
		fuseGap: null,
		drive: { enabled: false, state: "off", mountPoint: null, driveLetter: null, readOnly: false, error: null },
		serves: [SERVE],
		protocols: ["webdav"],
		cache: { usedBytes: 0, freeBytes: 0, pendingUploads: 0, erroredFiles: 0 },
		tuning: { cacheMaxGiB: 32, cacheMinFreeGiB: 16, cacheMaxAgeHours: 720, dirCacheSeconds: 15 },
		notices: [],
		...patch
	}
}

describe("mounts copy", () => {
	it("maps every error code to a key", () => {
		expectAllKeysExist(MOUNTS_ERROR_KEY, ERROR_CODES)
	})

	it("maps every mount point problem to a key", () => {
		const problems = [
			"notDirectory",
			"notEmpty",
			"symlink",
			"outsideHome",
			"homeDirectory",
			"appData",
			"temporary",
			"insidePair",
			"containsPair"
		]

		expectAllKeysExist(MOUNT_POINT_PROBLEM_KEY, problems)
		expect([...MOUNT_POINT_PROBLEMS].sort()).toEqual([...problems].sort())
	})

	it("maps every notice to a key and a page", () => {
		const notices = [
			"credentialsRegenerated",
			"addressInvalid",
			"mountPointInvalid",
			"legacyUploadsPending",
			"legacyCacheErrored",
			"certificateRegenerated"
		]

		expectAllKeysExist(NOTICE_KEY, notices)
		expect(Object.keys(NOTICE_SCOPE).sort()).toEqual([...notices].sort())
	})

	it("maps every role state, FUSE status, install result, address kind and protocol", () => {
		expectAllKeysExist(ROLE_STATE_KEY, ["off", "starting", "running", "stopping", "error"])
		expectAllKeysExist(FUSE_PROVIDER_KEY, ["macFuse", "nfsMount", "winFsp", "fuse3"])
		expectAllKeysExist(FUSE_GAP_KEY, ["fuse3", "device"])
		expectAllKeysExist(FUSE_INSTALL_KEY, ["installed", "rebootRequired", "canceled", "failed"])
		expectAllKeysExist(ADDRESS_KIND_KEY, ["loopback", "lan", "all"])
		expectAllKeysExist(PROTOCOL_LABEL_KEY, [...SERVE_PROTOCOLS])
		expect(CATALOG[roleStateKey("drive", "running")]).toBe("Mounted")
		expect(CATALOG[roleStateKey("webdav", "running")]).toBe("Running")
	})

	it("holds every host banner the shared host can show", () => {
		const states = [
			{ state: "starting" },
			{ state: "restarting", retryAt: 0 },
			{ state: "failed", reason: "crashLoop" },
			{ state: "failed", reason: "addonMissing" },
			{ state: "failed", reason: "baselineInUse" },
			{ state: "failed", reason: "keychainLocked" }
		] as const

		for (const host of states) {
			const banner = hostBanner(host)

			expect(banner).not.toBeNull()
			expect(CATALOG[banner?.key ?? ""], host.state).toBeTypeOf("string")
		}
	})

	it("ships both plural forms of every counted string", () => {
		for (const base of ["cachePending", "cacheErrored"]) {
			expect(CATALOG[`${base}_one`], base).toBeTypeOf("string")
			expect(CATALOG[`${base}_other`], base).toBeTypeOf("string")
		}
	})

	it("says directory, never folder", () => {
		for (const [key, value] of Object.entries(CATALOG)) {
			expect(/folder/i.test(value), key).toBe(false)
		}
	})

	it("tells a refused mount point by its problem", () => {
		expect(mountsErrorKey({ code: "mountPointInvalid", message: "notEmpty" })).toBe("problemNotEmpty")
		expect(mountsErrorKey({ code: "mountPointInvalid", message: "something else" })).toBe("errorMountPointInvalid")
		expect(mountsErrorKey({ code: "mountPointInvalid" })).toBe("errorMountPointInvalid")
		expect(mountsErrorKey({ code: "portInUse", message: "notEmpty" })).toBe("errorPortInUse")
	})
})

describe("aggregateMountsState", () => {
	it("is null before the first overview", () => {
		expect(aggregateMountsState(null)).toBeNull()
	})

	it("needs attention for a failed role or failed uploads, before pending uploads", () => {
		expect(aggregateMountsState(overview({ serves: [{ ...SERVE, state: "error", error: { code: "portInUse" } }] }))).toBe("attention")
		expect(aggregateMountsState(overview({ cache: { usedBytes: 0, freeBytes: 0, pendingUploads: 3, erroredFiles: 1 } }))).toBe(
			"attention"
		)
		expect(aggregateMountsState(overview({ cache: { usedBytes: 0, freeBytes: 0, pendingUploads: 3, erroredFiles: 0 } }))).toBe(
			"uploading"
		)
		expect(aggregateMountsState(overview())).toBe("idle")
	})

	it("counts a failed host only while something is meant to run", () => {
		const failed = { state: "failed", reason: "crashLoop" } as const

		expect(aggregateMountsState(overview({ host: failed }))).toBe("attention")
		expect(aggregateMountsState(overview({ host: failed, serves: [{ ...SERVE, enabled: false, state: "off" }] }))).toBe("idle")
	})
})

describe("drive", () => {
	it("read-only locked while mounted", () => {
		expect(driveReadOnlyLocked("running")).toBe(true)
		expect(driveReadOnlyLocked("starting")).toBe(true)
		expect(driveReadOnlyLocked("stopping")).toBe(true)
		expect(driveReadOnlyLocked("off")).toBe(false)
		expect(driveReadOnlyLocked("error")).toBe(false)
	})
})

describe("serve", () => {
	const LOOPBACK: DesktopListenAddress = { address: "127.0.0.1", kind: "loopback", interface: null }
	const LAN: DesktopListenAddress = { address: "192.168.1.5", kind: "lan", interface: "en0" }
	const ALL: DesktopListenAddress = { address: "0.0.0.0", kind: "all", interface: null }

	it("url per protocol: every protocol says how to connect", () => {
		expectAllKeysExist(CONNECT_HINT_KEY, [...SERVE_PROTOCOLS])
		expect(credentialLabels("s3")).toEqual({ user: "credentialAccessKeyId", secret: "credentialSecretAccessKey" })
		expect(credentialLabels("webdav")).toEqual({ user: "credentialUser", secret: "credentialPassword" })
	})

	// The shell ticks https when a server leaves loopback; the page warns when it is turned off there.
	it("LAN pre-ticks https: off a LAN address it sends plain text and turning it off warns", () => {
		const lan: DesktopServe = { ...SERVE, address: "192.168.1.5", addressKind: "lan" }

		expect(sendsPlainText(lan)).toBe(true)
		expect(sendsPlainText({ ...lan, https: true })).toBe(false)
		expect(sendsPlainText(SERVE)).toBe(false)
		expect(sendsPlainText({ ...lan, httpsCapable: false })).toBe(false)
		expect(httpsOffNeedsWarning(lan)).toBe(true)
		expect(httpsOffNeedsWarning({ ...lan, addressKind: "all" })).toBe(true)
		expect(httpsOffNeedsWarning(SERVE)).toBe(false)
	})

	it("unauthenticated needs the dialog, and stays on this device", () => {
		expect(enableNeedsAcknowledgement({ authenticated: false })).toBe(true)
		expect(enableNeedsAcknowledgement({ authenticated: true })).toBe(false)
		expect(addressChoices("nfs", [LOOPBACK, LAN, ALL])).toEqual([LOOPBACK])
		expect(addressChoices("webdav", [LOOPBACK, LAN, ALL])).toEqual([LOOPBACK, LAN, ALL])
	})

	it("parses a port and the cache settings to the shell's bounds", () => {
		expect(portInput("1900")).toBe(1900)
		expect(portInput("0")).toBeInstanceOf(type.errors)
		expect(portInput("65536")).toBeInstanceOf(type.errors)
		expect(portInput("19.5")).toBeInstanceOf(type.errors)
		expect(tuningInput({ cacheMaxGiB: "32", cacheMinFreeGiB: "0", cacheMaxAgeHours: "720", dirCacheSeconds: "15" })).toEqual({
			cacheMaxGiB: 32,
			cacheMinFreeGiB: 0,
			cacheMaxAgeHours: 720,
			dirCacheSeconds: 15
		})
		expect(tuningInput({ cacheMaxGiB: "0", cacheMinFreeGiB: "0", cacheMaxAgeHours: "720", dirCacheSeconds: "15" })).toBeInstanceOf(
			type.errors
		)
	})
})
