// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import type { DesktopMountsOverview, DesktopServe } from "@filen/shared/desktop"

// The overview tells why a role failed in plain sight: the drive's reason under its card, a server's in its tile (the
// tile's link covers it, so a title tooltip there was never reachable).

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => undefined, desktopPlatform: () => "linux" }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children)
}))
vi.mock("@/features/mounts/components/driveHero", () => ({ DriveHero: () => null }))
vi.mock("@/features/mounts/components/fuseCallout", () => ({ FuseCallout: () => null }))

import "@/lib/i18n"
import { useMountsStore } from "@/features/mounts/lib/mountsStore"
import { MountsOverview } from "@/features/mounts/components/mountsOverview"

const SERVE: DesktopServe = {
	protocol: "webdav",
	enabled: true,
	state: "off",
	address: "127.0.0.1",
	addressKind: "loopback",
	port: 1900,
	httpsCapable: true,
	https: false,
	readOnly: false,
	authenticated: true,
	url: null,
	tlsFingerprint: null,
	error: null
}

const PORT_IN_USE = "That port is in use. Choose another one."
const MOUNT_POINT_IN_USE = "Something is already mounted there."

function overview(drive: DesktopMountsOverview["drive"], serves: DesktopServe[]): DesktopMountsOverview {
	return {
		host: { state: "running" },
		available: true,
		fuse: { state: "ready", provider: "fuse3" },
		fuseGap: null,
		drive,
		serves,
		protocols: ["webdav"],
		cache: { usedBytes: 0, freeBytes: 0, pendingUploads: 0, erroredFiles: 0 },
		tuning: { cacheMaxGiB: 32, cacheMinFreeGiB: 16, cacheMaxAgeHours: 720, dirCacheSeconds: 15 },
		notices: []
	}
}

const DRIVE: DesktopMountsOverview["drive"] = {
	enabled: true,
	state: "off",
	mountPoint: "/home/a/Filen",
	driveLetter: null,
	readOnly: false,
	error: null
}

beforeEach(() => {
	useMountsStore.setState({ overview: null })
})

describe("mounts overview errors", () => {
	it("shows a failed server's reason as visible text in its tile", () => {
		useMountsStore.setState({ overview: overview(DRIVE, [{ ...SERVE, state: "error", error: { code: "portInUse" } }]) })
		render(createElement(MountsOverview))

		const reason = screen.getByText(PORT_IN_USE)

		expect(reason.closest("article")).not.toBeNull()
		expect(reason.getAttribute("title")).toBeNull()
		expect(screen.queryByText(MOUNT_POINT_IN_USE)).toBeNull()
	})

	it("shows the drive's error under its card", () => {
		useMountsStore.setState({ overview: overview({ ...DRIVE, state: "error", error: { code: "mountPointInUse" } }, [SERVE]) })
		render(createElement(MountsOverview))

		expect(screen.getByText(MOUNT_POINT_IN_USE)).not.toBeNull()
		expect(screen.queryByText(PORT_IN_USE)).toBeNull()
	})
})
