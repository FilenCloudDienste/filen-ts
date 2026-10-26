import { describe, expect, it } from "vitest"
import { badgeDotBitmap } from "../main/badge.ts"

describe("badgeDotBitmap", () => {
	it("is an opaque dot with clear corners", () => {
		const size = 16
		const bitmap = badgeDotBitmap(size)
		const alpha = (x: number, y: number) => bitmap[(y * size + x) * 4 + 3]

		expect(bitmap.length).toBe(size * size * 4)
		expect(alpha(8, 8)).toBe(255)
		expect(alpha(0, 0)).toBe(0)
	})
})
