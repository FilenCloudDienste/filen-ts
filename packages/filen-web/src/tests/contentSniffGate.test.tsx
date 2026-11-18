// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"

// A `.ts` that may be a transport stream renders nothing until one probe says which it is; the verdict then
// picks the viewer through previewType. Anything else never waits, and nothing is probed twice.

const probe = vi.hoisted(() => ({ probeTransportStream: vi.fn<() => Promise<boolean | null>>() }))

vi.mock("@/features/preview/lib/transportStreamProbe", () => probe)

const { ContentSniffGate } = await import("@/features/preview/components/contentSniffGate")
const { previewType } = await import("@/features/drive/lib/preview.logic")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")
const { PreviewAccessModeProvider } = await import("@/features/preview/lib/accessMode")
const { attachFileKindVerdictStorage } = await import("@/features/drive/lib/fileKindVerdicts")

// What reaches kv of the verdicts the gate records.
const saved: string[] = []

attachFileKindVerdictStorage({
	load: () => Promise.resolve([]),
	save: uuid => {
		saved.push(uuid)

		return Promise.resolve()
	},
	remove: () => Promise.resolve()
})

function renderGate(
	name: string,
	size: bigint,
	uuid: `${string}-${string}-${string}-${string}-${string}`,
	access: "authed" | "anon" = "authed"
) {
	const item = linkedFileItem(name, { size, uuid })
	const gate = createElement(ContentSniffGate, {
		item,
		asText: false,
		render: () => createElement("p", null, `viewer:${previewType(item)}`)
	})

	render(access === "anon" ? createElement(PreviewAccessModeProvider, { mode: "anon", linkScope: "scope", children: gate }) : gate)
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("ContentSniffGate on a .ts", () => {
	it("renders a file that cannot be a transport stream at once, probing nothing", () => {
		renderGate("index.ts", 4_000n, "a1000000-0000-0000-0000-000000000000")

		expect(screen.getByText("viewer:code")).toBeTruthy()
		expect(probe.probeTransportStream).not.toHaveBeenCalled()
	})

	it("probes a large .ts once and opens it as video when it is a transport stream", async () => {
		probe.probeTransportStream.mockResolvedValue(true)
		renderGate("clip.ts", 4_000_000n, "a2000000-0000-0000-0000-000000000000")

		expect(screen.queryByText(/viewer:/)).toBeNull()

		await waitFor(() => {
			expect(screen.getByText("viewer:video")).toBeTruthy()
		})
		expect(probe.probeTransportStream).toHaveBeenCalledOnce()
		expect(saved).toContain("a2000000-0000-0000-0000-000000000000")
	})

	// A shared browser's next signed-in user must not inherit what an anonymous visit read.
	it("keeps a public link's verdict in memory only", async () => {
		probe.probeTransportStream.mockResolvedValue(true)
		renderGate("clip.ts", 4_000_000n, "a7000000-0000-0000-0000-000000000000", "anon")

		await waitFor(() => {
			expect(screen.getByText("viewer:video")).toBeTruthy()
		})
		expect(probe.probeTransportStream).toHaveBeenCalledOnce()
		expect(saved).not.toContain("a7000000-0000-0000-0000-000000000000")
	})

	it("opens TypeScript as code, the body's large text viewer taking it above the text cap", async () => {
		probe.probeTransportStream.mockResolvedValue(false)
		renderGate("types.ts", 4_000_000n, "a3000000-0000-0000-0000-000000000000")

		await waitFor(() => {
			expect(screen.getByText("viewer:code")).toBeTruthy()
		})

		cleanup()
		renderGate("bundle.ts", 40_000_000n, "a4000000-0000-0000-0000-000000000000")

		await waitFor(() => {
			expect(screen.getByText("viewer:code")).toBeTruthy()
		})
	})

	it("opens a large .mts the probe finds to be TypeScript as code", async () => {
		probe.probeTransportStream.mockResolvedValue(false)
		renderGate("module.mts", 4_000_000n, "a6000000-0000-0000-0000-000000000000")

		await waitFor(() => {
			expect(screen.getByText("viewer:code")).toBeTruthy()
		})
	})

	it("offers Retry when the probe could not be read, and probes again", async () => {
		probe.probeTransportStream.mockResolvedValueOnce(null).mockResolvedValueOnce(true)
		renderGate("clip.ts", 4_000_000n, "a5000000-0000-0000-0000-000000000000")

		const retry = await screen.findByRole("button", { name: "Try again" })

		await act(async () => {
			retry.click()
			await Promise.resolve()
		})

		await waitFor(() => {
			expect(screen.getByText("viewer:video")).toBeTruthy()
		})
		expect(probe.probeTransportStream).toHaveBeenCalledTimes(2)
	})
})
