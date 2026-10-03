// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { CompressFormat } from "@filen/sdk-rs"
import { formatBytes } from "@filen/shared"
import "@/lib/i18n"

const { archiveFormatInfo } = vi.hoisted(() => ({
	// Memory grows with the level: 1 MiB per level.
	archiveFormatInfo: vi.fn((formats: CompressFormat[]) =>
		Promise.resolve(
			formats.map(format => {
				const level = format.type === "tar" ? (format.compression?.level ?? 0) : 0

				return {
					extension: ".tar.gz",
					levels: { min: 1, max: 9, defaultLevel: 6 },
					maxLevel: 5,
					encoderMemory: level * 1024 * 1024
				}
			})
		)
	)
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { archiveFormatInfo } }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children)
}))

import { ArchiveLevelField, type ArchiveLevelFieldProps } from "@/features/drive/components/archiveLevelField"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// The thumb stays visibility:hidden until it is measured, which jsdom never does.
function slider(): HTMLInputElement {
	return screen.getByRole("slider", { hidden: true })
}

const LEVELS = { min: 1, max: 9, defaultLevel: 6 }
const BUDGET = 128 * 1024 * 1024

function renderField(props: Partial<ArchiveLevelFieldProps> & { probe: CompressFormat }): void {
	render(
		createElement(ArchiveLevelField, {
			levels: LEVELS,
			maxLevel: 5,
			value: 3,
			budget: BUDGET,
			onChange: vi.fn(),
			...props
		}),
		{ wrapper: queryClientWrapper(createTestQueryClient()) }
	)
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("ArchiveLevelField", () => {
	it("caps the slider at the highest level the budget runs and explains the rest", async () => {
		renderField({ probe: { type: "tar", compression: { codec: "gzip" } } })

		expect(slider().getAttribute("max")).toBe("5")
		expect(slider().getAttribute("min")).toBe("1")
		expect(slider().getAttribute("aria-labelledby")).toBe(screen.getByText("Compression level").id)

		const note = screen.getByText(`Levels 6–9 need more than the ${formatBytes(BUDGET)} of archive memory set in Advanced settings`)

		expect(note.closest("a")?.getAttribute("href")).toBe("/settings/advanced")
		expect(await screen.findByText(`Level 3 · uses about ${formatBytes(3 * 1024 * 1024)} while compressing`)).toBeTruthy()
	})

	it("asks the memory of every reachable level in one worker call, and only while shown", async () => {
		expect(archiveFormatInfo).not.toHaveBeenCalled()

		renderField({ probe: { type: "tar", compression: { codec: "xz" } } })

		await screen.findByText(/^Level 3 ·/)

		expect(archiveFormatInfo).toHaveBeenCalledTimes(1)
		expect(archiveFormatInfo.mock.calls[0]?.[0]).toEqual(
			[1, 2, 3, 4, 5].map(level => ({ type: "tar", compression: { codec: "xz", level } }))
		)
	})

	it("shows no locked note when every level fits, and is disabled when only the lowest does", async () => {
		renderField({ probe: { type: "tar", compression: { codec: "zstd" } }, maxLevel: 9 })

		expect(screen.queryByText(/need more than/)).toBeNull()
		expect(slider().getAttribute("max")).toBe("9")

		cleanup()
		renderField({ probe: { type: "tar", compression: { codec: "bzip2" } }, maxLevel: 1, value: 1 })

		await waitFor(() => {
			expect(slider().disabled).toBe(true)
		})
		expect(screen.getByText(/^Levels 2–9 need more than/)).toBeTruthy()
	})

	it("names the one locked level on its own", () => {
		renderField({ probe: { type: "tar", compression: { codec: "xz" } }, maxLevel: 8 })

		expect(
			screen.getByText(`Level 9 needs more than the ${formatBytes(BUDGET)} of archive memory set in Advanced settings`)
		).toBeTruthy()
	})

	it("shows a single-level format's level, without a slider", async () => {
		renderField({
			probe: { type: "tar", compression: { codec: "lz4" } },
			levels: { min: 1, max: 1, defaultLevel: 1 },
			maxLevel: 1,
			value: 1
		})

		expect(await screen.findByText(`Level 1 · uses about ${formatBytes(1024 * 1024)} while compressing`)).toBeTruthy()
		expect(screen.queryByRole("slider", { hidden: true })).toBeNull()
		expect(screen.queryByText("Faster")).toBeNull()
		expect(screen.queryByText(/need more than/)).toBeNull()
	})
})
