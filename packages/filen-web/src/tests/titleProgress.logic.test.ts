import { describe, expect, it } from "vitest"
import { titleProgress, type TitleDocument } from "@/features/transfers/lib/titleProgress.logic"

// A document whose title writes are counted.
function doc(hidden: boolean): TitleDocument & { writes: number; hidden: boolean } {
	let title = "Drive - Filen"
	const state = {
		writes: 0,
		hidden,
		get title() {
			return title
		},
		set title(next: string) {
			state.writes += 1
			title = next
		}
	}

	return state
}

const format = (percent: number, title: string): string => `${String(percent)}% · ${title}`

describe("titleProgress", () => {
	it("writes the title only when the whole percent changes", () => {
		const d = doc(true)
		const progress = titleProgress(d, format)

		progress.update(10.2)
		progress.update(10.7)
		progress.update(10.9)

		expect(d.title).toBe("10% · Drive - Filen")
		expect(d.writes).toBe(1)

		progress.update(11.01)

		expect(d.title).toBe("11% · Drive - Filen")
		expect(d.writes).toBe(2)
	})

	it("leaves a visible tab's title alone", () => {
		const d = doc(false)

		titleProgress(d, format).update(40)

		expect(d.writes).toBe(0)
	})

	it("restores the title when the tab shows or nothing runs", () => {
		const d = doc(true)
		const progress = titleProgress(d, format)

		progress.update(40)
		d.hidden = false
		progress.update(41)

		expect(d.title).toBe("Drive - Filen")

		d.hidden = true
		progress.update(50)
		progress.update(null)

		expect(d.title).toBe("Drive - Filen")
	})

	it("keeps a title someone else wrote meanwhile, building on it", () => {
		const d = doc(true)
		const progress = titleProgress(d, format)

		progress.update(40)
		d.title = "Photos - Filen"
		progress.update(40)

		expect(d.title).toBe("40% · Photos - Filen")

		d.title = "Notes - Filen"
		progress.update(null)

		expect(d.title).toBe("Notes - Filen")
	})
})
