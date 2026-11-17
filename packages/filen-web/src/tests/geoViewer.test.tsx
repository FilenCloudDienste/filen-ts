// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { GeoSummary } from "@/features/preview/workers/geo.worker"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// The track viewer's states: the summary line and the plot, the network-reference notice, the card for a file with too
// many points or none, and the card for one that does not read, with Source.

const { load } = vi.hoisted(() => ({ load: { next: (): Promise<GeoSummary> => new Promise(() => undefined) } }))
const worker = vi.hoisted(() => ({
	status: "ready",
	generation: 1,
	owned: { run: (call: (remote: unknown) => unknown) => call({ load: () => load.next(), setColors: () => Promise.resolve() }) }
}))

vi.mock("@/lib/workers/ownedWorker", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/workers/ownedWorker")>()),
	useOwnedWorker: () => worker
}))
vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "light" }), resolveTheme: () => "light" }))
vi.mock("@/features/preview/workers/geo.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array([1]), refetch: () => undefined })
}))
vi.mock("@/features/preview/components/canvasViewerShell", () => ({
	CanvasViewerShell: ({ notice }: { notice?: unknown }) => (
		<div>
			plot
			{notice as never}
		</div>
	)
}))

function summary(overrides: Partial<GeoSummary> = {}): GeoSummary {
	return {
		stats: {
			points: 3,
			distance: 42_300,
			gain: 612,
			loss: 598,
			duration: 7_864_000,
			moving: 7_090_000,
			maxSpeed: 10,
			minElevation: 400,
			maxElevation: 900,
			bounds: { minLon: 8, minLat: 47, maxLon: 8.1, maxLat: 47.1 }
		},
		waypoints: 0,
		references: 0,
		tooMany: false,
		profile: { distance: new Float64Array(0), elevation: new Float64Array(0) },
		...overrides
	}
}

afterEach(() => {
	cleanup()
})

async function renderViewer(name = "ride.gpx"): Promise<void> {
	const { GeoViewer } = await import("@/features/preview/components/geoViewer")

	render(<GeoViewer item={linkedFileItem(name)} />)
}

describe("GeoViewer", () => {
	it("shows the summary and the plot, and the references a KML names", async () => {
		load.next = () => Promise.resolve(summary({ references: 2 }))
		await renderViewer("places.kml")

		expect(await screen.findByText(/42\.3 km · ↑ 612 m ↓ 598 m · 2:11:04 \(1:58:10 moving\)/)).toBeTruthy()
		expect(screen.getByText("plot")).toBeTruthy()
		expect(screen.getByText("2 network references not loaded")).toBeTruthy()
	})

	it("describes a file with too many points without plotting it", async () => {
		load.next = () => Promise.resolve(summary({ tooMany: true }))
		await renderViewer()

		expect(await screen.findByText("Too many points to plot.")).toBeTruthy()
		expect(screen.queryByText("plot")).toBeNull()
	})

	it("offers the source of a file that does not read, and none for a KMZ", async () => {
		load.next = () => Promise.reject(new Error("not XML"))
		await renderViewer()

		expect(await screen.findByText("This file couldn't be read as a track.")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Source" })).toBeTruthy()

		cleanup()
		load.next = () => Promise.reject(new Error("not a zip"))
		await renderViewer("places.kmz")

		expect(await screen.findByText("This file couldn't be read as a track.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Source" })).toBeNull()
	})
})
