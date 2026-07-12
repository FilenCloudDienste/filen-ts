import { describe, expect, it } from "vitest"
import { NAME_COLOR_PALETTE, senderNameColor } from "@/features/chats/lib/nameColor"

describe("senderNameColor", () => {
	it("returns undefined in a 1:1 chat (coloring disabled)", () => {
		expect(senderNameColor("12345", true)).toBeUndefined()
		expect(senderNameColor("any-seed", true)).toBeUndefined()
	})

	it("returns a palette color in a group chat", () => {
		const color = senderNameColor("12345", false)

		expect(color).toBeDefined()
		expect(NAME_COLOR_PALETTE).toContain(color)
	})

	it("is stable — the same seed always maps to the same color", () => {
		const first = senderNameColor("user-99", false)

		for (let i = 0; i < 25; i++) {
			expect(senderNameColor("user-99", false)).toBe(first)
		}
	})

	it("distributes distinct seeds across most of the palette", () => {
		const used = new Set<string>()

		for (let id = 0; id < 200; id++) {
			const color = senderNameColor(String(id), false)

			if (color !== undefined) {
				used.add(color)
			}
		}

		// Every distinct seed lands somewhere in the fixed palette, and a realistic spread of ids
		// exercises nearly all of the 16 buckets (never collapses onto one or two colors).
		expect(used.size).toBeGreaterThanOrEqual(NAME_COLOR_PALETTE.length - 2)

		for (const color of used) {
			expect(NAME_COLOR_PALETTE).toContain(color)
		}
	})

	it("exposes a fixed 16-entry palette of unique hex colors", () => {
		expect(NAME_COLOR_PALETTE).toHaveLength(16)
		expect(new Set(NAME_COLOR_PALETTE).size).toBe(NAME_COLOR_PALETTE.length)

		for (const color of NAME_COLOR_PALETTE) {
			expect(color).toMatch(/^#[0-9a-f]{6}$/)
		}
	})
})
