import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { DesktopPlatform, DesktopSyncHostState } from "@filen/shared/desktop"
import type { NativeAggregate } from "../shared/nativeProtocol.ts"
import {
	attentionPair,
	attentionTransitions,
	trayIconFile,
	trayState,
	type TrayState,
	traySyncStatus,
	trayTooltip
} from "../main/sync/tray.ts"

const RUNNING: DesktopSyncHostState = { state: "running" }

describe("sync tray", () => {
	it("attention wins over syncing", () => {
		expect(trayState("attention", RUNNING)).toBe("attention")
		expect(trayState("syncing", RUNNING)).toBe("syncing")
		expect(trayState("syncing", { state: "failed", reason: "crashLoop" })).toBe("attention")
		expect(trayState("syncing", { state: "restarting", retryAt: 1 })).toBe("idle")
		expect(trayState("attention", { state: "off" })).toBe("idle")
	})

	it("notifies once per transition", () => {
		const aggregates: NativeAggregate[] = ["idle", "syncing", "attention", "attention", "syncing", "attention", "idle"]
		let previous: TrayState = "idle"
		let notified = 0

		for (const aggregate of aggregates) {
			const next = trayState(aggregate, RUNNING)

			if (attentionTransitions(previous, next)) {
				notified++
			}

			previous = next
		}

		expect(notified).toBe(2)
	})

	it("shows a status only while sync runs or failed", () => {
		expect(trayTooltip("idle", { state: "off" })).toBe("Filen")
		expect(traySyncStatus("idle", RUNNING)).toBe("Sync up to date")
		expect(trayTooltip("syncing", RUNNING)).toBe("Filen: Syncing…")
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
