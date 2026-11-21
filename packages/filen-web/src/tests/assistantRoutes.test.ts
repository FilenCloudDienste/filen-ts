import { describe, expect, it, vi } from "vitest"

const desktop = vi.hoisted(() => ({ app: false }))

vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => desktop.app, desktopBridge: () => undefined }))

const { screenOfPath, UNAVAILABLE_ROUTES } = await import("@/features/assistant/tools/routes")

describe("assistant routes", () => {
	// settings_storage opens Advanced, where the caches live, without taking the page's own name.
	it("reports Advanced as settings_advanced", () => {
		expect(screenOfPath("/settings/advanced")).toBe("settings_advanced")
		expect(screenOfPath("/settings/account")).toBe("settings_account")
	})

	it("reports the Office page as settings_office", () => {
		expect(screenOfPath("/settings/office")).toBe("settings_office")
	})

	it("reports the Audio page as settings_audio", () => {
		expect(screenOfPath("/settings/audio")).toBe("settings_audio")
	})

	it("reports videos, sync, mounts and the desktop settings by their own names", () => {
		expect(screenOfPath("/videos/movies")).toBe("videos")
		expect(screenOfPath("/sync/pair1/issues")).toBe("sync")
		expect(screenOfPath("/mounts/drive")).toBe("mounts")
		expect(screenOfPath("/settings/desktop")).toBe("settings_desktop")
		expect(screenOfPath("/settings")).toBe("settings")
	})

	it("opens sync, mounts and the desktop settings only in the desktop app, and plans only on the web", async () => {
		expect([...UNAVAILABLE_ROUTES].sort()).toEqual(["mounts", "settings_camera_upload", "settings_desktop", "sync"])

		desktop.app = true
		vi.resetModules()

		const inDesktop = (await import("@/features/assistant/tools/routes")).UNAVAILABLE_ROUTES

		expect([...inDesktop].sort()).toEqual(["settings_camera_upload", "settings_plans"])
	})
})
