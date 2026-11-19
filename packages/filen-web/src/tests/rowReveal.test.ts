import { describe, expect, it } from "vitest"
import { cn } from "@filen/shared"
import { REVEAL_CLASS } from "@/components/rowReveal"

const classes = (value: string) => value.split(" ")

describe("REVEAL_CLASS.trow", () => {
	it("reveals on the track row's hover group and stays visible on a coarse pointer", () => {
		const list = classes(REVEAL_CLASS.trow)

		expect(list).toContain("group-hover/trow:opacity-100")
		expect(list).toContain("pointer-coarse:opacity-100")
		expect(list).toContain("pointer-coarse:size-8")
		expect(list).toContain("opacity-0")
	})

	it("lets the removing state force the trigger visible", () => {
		const list = classes(cn(REVEAL_CLASS.trow, "transition-opacity", "opacity-100"))

		expect(list).toContain("opacity-100")
		expect(list).not.toContain("opacity-0")
		expect(list).toContain("pointer-coarse:opacity-100")
	})
})
