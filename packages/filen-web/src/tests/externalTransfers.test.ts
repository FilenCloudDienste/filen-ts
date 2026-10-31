import { describe, expect, it } from "vitest"
import type { DesktopDrive, DesktopMountsStats, DesktopServe, DesktopSyncPair } from "@filen/shared/desktop"
import {
	attributeMounts,
	mountsRunning,
	mountsTransferRows,
	syncActivity,
	syncTransferRows
} from "@/features/transfers/lib/externalTransfers.logic"

function pair(id: string, name: string, transfers: DesktopSyncPair["transfers"]): DesktopSyncPair {
	return {
		id,
		name,
		localRoot: `/Users/a/${name}`,
		remoteRoot: `uuid-${id}`,
		mode: "twoWay",
		paused: false,
		phase: transfers.length > 0 ? "syncing" : "idle",
		progress: null,
		transfers,
		lastSyncedAt: null,
		lastError: null,
		issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 },
		degraded: { local: false, remote: false },
		review: null,
		notices: [],
		stage: null,
		halted: null,
		refused: null,
		rootProblem: null,
		holds: [],
		info: []
	}
}

function drive(patch: Partial<DesktopDrive> = {}): DesktopDrive {
	return { enabled: true, state: "running", mountPoint: "/Users/a/Filen", driveLetter: null, readOnly: false, error: null, ...patch }
}

function serve(patch: Partial<DesktopServe> = {}): DesktopServe {
	return {
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
		error: null,
		...patch
	}
}

const STATS: DesktopMountsStats = {
	transfers: [
		{ name: "Documents/a.pdf", bytes: 10, total: 40, speed: 5 },
		{ name: "Documents/a.pdf", bytes: 10, total: 40, speed: 5 },
		{ name: "b.bin", bytes: 0, total: 0, speed: 0 }
	],
	uploadsInProgress: 2,
	uploadsQueued: 3
}

describe("syncTransferRows", () => {
	it("lists every pair's transfers in pair order, tagged with the pair", () => {
		const rows = syncTransferRows([
			pair("1", "Documents", [{ relPath: "x/a.txt", direction: "upload", bytes: 1, total: 2 }]),
			pair("2", "Photos", []),
			pair("3", "Music", [
				{ relPath: "b.mp3", direction: "download", bytes: 0, total: 0 },
				{ relPath: "b.mp3", direction: "upload", bytes: 3, total: 9 }
			])
		])

		expect(rows.map(row => row.id)).toEqual(["sync:1:upload:x/a.txt", "sync:3:download:b.mp3", "sync:3:upload:b.mp3"])
		expect(rows[0]).toEqual({
			kind: "transfer",
			id: "sync:1:upload:x/a.txt",
			path: "x/a.txt",
			direction: "upload",
			bytes: 1,
			total: 2,
			speed: null,
			source: { kind: "sync", pairId: "1", name: "Documents" }
		})
	})

	it("is empty without an overview (a browser)", () => {
		expect(syncTransferRows(undefined)).toEqual([])
	})
})

describe("attributeMounts", () => {
	it("names the one running role", () => {
		expect(attributeMounts(drive(), [serve({ state: "off" })])).toEqual({ transfers: "drive", uploads: "drive" })
		expect(attributeMounts(drive({ state: "off" }), [serve({ protocol: "s3", state: "stopping" })])).toEqual({
			transfers: "s3",
			uploads: "s3"
		})
	})

	it("names none while several roles share rclone's stats", () => {
		expect(attributeMounts(drive(), [serve()])).toEqual({ transfers: null, uploads: null })
	})

	it("gives the uploads to the one writable role", () => {
		expect(attributeMounts(drive(), [serve({ readOnly: true })])).toEqual({ transfers: null, uploads: "drive" })
		expect(attributeMounts(drive({ readOnly: true }), [])).toEqual({ transfers: "drive", uploads: null })
	})

	it("counts neither starting nor failed roles", () => {
		expect(attributeMounts(drive({ state: "starting" }), [serve({ state: "error" })])).toEqual({ transfers: null, uploads: null })
		expect(mountsRunning(drive({ state: "starting" }), [serve({ state: "error" })])).toBe(false)
		expect(mountsRunning(drive({ state: "off" }), [serve()])).toBe(true)
		expect(mountsRunning(undefined, undefined)).toBe(false)
	})
})

describe("mountsTransferRows", () => {
	it("lists rclone's transfers once each as uploads, then the waiting uploads as one row", () => {
		const rows = mountsTransferRows(STATS, { transfers: null, uploads: "drive" })

		expect(rows).toEqual([
			{
				kind: "transfer",
				id: "mounts:Documents/a.pdf",
				path: "Documents/a.pdf",
				direction: "upload",
				bytes: 10,
				total: 40,
				speed: 5,
				source: { kind: "mounts", role: null }
			},
			{
				kind: "transfer",
				id: "mounts:b.bin",
				path: "b.bin",
				direction: "upload",
				bytes: 0,
				total: 0,
				speed: 0,
				source: { kind: "mounts", role: null }
			},
			{ kind: "queued", id: "mounts:queued", count: 3, source: { kind: "mounts", role: "drive" } }
		])
	})

	it("adds no waiting row without waiting uploads, and nothing without stats", () => {
		expect(mountsTransferRows({ ...STATS, transfers: [], uploadsQueued: 0 }, { transfers: null, uploads: null })).toEqual([])
		expect(mountsTransferRows(null, { transfers: "drive", uploads: "drive" })).toEqual([])
	})
})

describe("syncActivity", () => {
	it("counts every sync transfer and the bytes of those of known size", () => {
		expect(
			syncActivity([
				pair("1", "Documents", [
					{ relPath: "a", direction: "upload", bytes: 5, total: 10 },
					{ relPath: "b", direction: "download", bytes: 0, total: 0 }
				]),
				pair("2", "Photos", [{ relPath: "c", direction: "upload", bytes: 50, total: 40 }])
			])
		).toEqual({ count: 3, bytes: 45, total: 50 })
		expect(syncActivity(undefined)).toEqual({ count: 0, bytes: 0, total: 0 })
	})
})
