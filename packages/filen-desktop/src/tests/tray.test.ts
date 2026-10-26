import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { DesktopPlatform, DesktopSyncHostState } from "@filen/shared/desktop"
import type { NativeAggregate, NativeMountsStatus } from "../shared/nativeProtocol.ts"
import {
	attentionPair,
	attentionTransitions,
	mountsAggregate,
	newlyFailedRoles,
	roleFailureMessage,
	trayIconFile,
	trayState,
	type TrayState,
	trayStatusLines,
	traySyncStatus,
	trayTooltip
} from "../main/tray.ts"

const RUNNING: DesktopSyncHostState = { state: "running" }

function status(roles: NativeMountsStatus["roles"], pending = 0): NativeMountsStatus {
	return { roles, uploads: { pending, errored: 0 } }
}

describe("tray", () => {
	it("attention wins over syncing", () => {
		expect(trayState("attention", "idle", RUNNING)).toBe("attention")
		expect(trayState("syncing", "idle", RUNNING)).toBe("syncing")
		expect(trayState("syncing", "idle", { state: "failed", reason: "crashLoop" })).toBe("attention")
		expect(trayState("syncing", "idle", { state: "restarting", retryAt: 1 })).toBe("idle")
		expect(trayState("attention", "idle", { state: "off" })).toBe("idle")
		expect(trayState("syncing", "attention", RUNNING)).toBe("attention")
	})

	it("uploading shows syncing", () => {
		const uploading = mountsAggregate(status([{ role: "drive", state: "running", error: null }], 3))

		expect(uploading).toBe("syncing")
		expect(trayState("idle", uploading, RUNNING)).toBe("syncing")
		expect(trayStatusLines("idle", uploading, RUNNING, "/Users/u/Filen")).toEqual([
			"Sync up to date",
			"Uploading from the network drive…",
			"Network drive: mounted at /Users/u/Filen"
		])
		expect(mountsAggregate(null)).toBe("idle")
		expect(mountsAggregate({ roles: [], uploads: null })).toBe("idle")
	})

	it("role error shows attention", () => {
		const failed = status([
			{ role: "drive", state: "running", error: null },
			{ role: "webdav", state: "error", error: { code: "portInUse" } }
		])
		const aggregate = mountsAggregate(failed)

		expect(aggregate).toBe("attention")
		expect(trayState("syncing", aggregate, RUNNING)).toBe("attention")
		expect(trayTooltip(trayStatusLines("idle", aggregate, RUNNING, null))).toBe("Filen: Mounts need attention")
		// Sync's own attention stays first.
		expect(trayStatusLines("attention", aggregate, RUNNING, null)).toEqual(["Sync needs attention", "Mounts need attention"])
		expect(newlyFailedRoles(null, failed)).toEqual(["webdav"])
		expect(newlyFailedRoles(failed, failed)).toEqual([])
		expect(roleFailureMessage(["webdav"])).toBe("The WebDAV server stopped. Open Filen to see why.")
		expect(roleFailureMessage(["drive", "s3"])).toBe("Mounts stopped. Open Filen to see why.")
	})

	it("notifies once per transition", () => {
		const aggregates: NativeAggregate[] = ["idle", "syncing", "attention", "attention", "syncing", "attention", "idle"]
		let previous: TrayState = "idle"
		let notified = 0

		for (const aggregate of aggregates) {
			const next = trayState(aggregate, "idle", RUNNING)

			if (attentionTransitions(previous, next)) {
				notified++
			}

			previous = next
		}

		expect(notified).toBe(2)
	})

	it("shows a status only while the host runs or failed", () => {
		expect(trayTooltip(trayStatusLines("idle", "idle", { state: "off" }, null))).toBe("Filen")
		expect(trayStatusLines("idle", "syncing", { state: "off" }, "/Users/u/Filen")).toEqual([])
		expect(traySyncStatus("idle", RUNNING)).toBe("Sync up to date")
		expect(trayTooltip(trayStatusLines("syncing", "idle", RUNNING, null))).toBe("Filen: Syncing…")
		expect(traySyncStatus("attention", { state: "failed", reason: "keychainLocked" })).toBe("Sync stopped")
	})

	it("every state has its icon on every platform", () => {
		const directory = path.join(import.meta.dirname, "..", "..", "build", "tray")

		for (const platform of ["darwin", "win32", "linux"] satisfies DesktopPlatform[]) {
			for (const state of ["idle", "syncing", "attention"] satisfies TrayState[]) {
				const file = trayIconFile(platform, state)

				expect(existsSync(path.join(directory, file)), file).toBe(true)

				if (platform === "darwin") {
					expect(file.endsWith("Template.png")).toBe(true)
					expect(existsSync(path.join(directory, file.replace(".png", "@2x.png")))).toBe(true)
				}
			}
		}
	})

	it("opens the pair that asked last", () => {
		expect(
			attentionPair(
				[
					{ pairId: "1", at: 1, kind: "conflict" },
					{ pairId: "2", at: 2, kind: "uploaded" }
				],
				null
			)
		).toBe("1")
		expect(attentionPair([{ pairId: "2", at: 2, kind: "passCompleted" }], "1")).toBe("1")
	})
})
