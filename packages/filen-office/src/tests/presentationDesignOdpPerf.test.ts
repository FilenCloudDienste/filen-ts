import { describe, expect, it } from "vitest"
import { encodePng } from "../core/metafile/dib"
import { designOdp } from "./presentationDesignFixtures"
import { driveSession } from "./odpWriteDrive"
import { cpuMs } from "./timing"

// An ODP deck of 100 pages: a picture background applied to every page (the command and the save, which stores the
// picture once and every page names one page style naming one draw:fill-image), and a gallery theme applied to every page
// (the command, which reads the generated master page, and the save, which writes it into styles.xml and every page's
// master reference). Worker CPU, the least of three runs. The commands are mostly the parse and proof of every page
// (a solid background on every page costs the same).

const PAGES = 100
const COMMAND_BUDGET_MS = 400
const SAVE_BUDGET_MS = 150

function picture(): Uint8Array {
	const size = 256
	const pixels = new Uint8Array(size * size * 4)

	for (let k = 0; k < size * size; k++) pixels.set([k & 0xff, (k >> 8) & 0xff, 128, 255], k * 4)

	return encodePng(pixels, size, size)
}

describe("presentationDesignOdpPerf", () => {
	it(`applies a picture background to ${String(PAGES)} ODP pages and saves within budget`, { timeout: 120_000 }, async ({ task }) => {
		const bytes = await designOdp(PAGES)
		const image = picture()
		let command = Number.POSITIVE_INFINITY
		let save = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const d = await driveSession(bytes)
			const start = cpuMs()
			const result = await d.command({
				family: "design",
				kind: "setBackground",
				slides: "all",
				background: { kind: "fill", fill: { kind: "picture", stretch: { l: 0, t: 0, r: 0, b: 0 } } },
				image: { bytes: image, contentType: "image/png", width: 256, height: 256 }
			})

			command = Math.min(command, cpuMs() - start)
			expect(result.ok).toBe(true)

			const saving = cpuMs()
			const saved = await d.save()

			save = Math.min(save, cpuMs() - saving)
			expect(saved.result.kind).toBe("written")
		}

		Object.assign(task.meta, {
			perf: { commandCpuMs: { value: command, budget: COMMAND_BUDGET_MS }, saveCpuMs: { value: save, budget: SAVE_BUDGET_MS } }
		})
		expect(command).toBeLessThanOrEqual(COMMAND_BUDGET_MS)
		expect(save).toBeLessThanOrEqual(SAVE_BUDGET_MS)
	})

	it(`applies a gallery theme to ${String(PAGES)} ODP pages and saves within budget`, { timeout: 120_000 }, async ({ task }) => {
		const bytes = await designOdp(PAGES)
		let command = Number.POSITIVE_INFINITY
		let save = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const d = await driveSession(bytes)
			const start = cpuMs()
			const result = await d.command({
				family: "design",
				kind: "setTheme",
				theme: { kind: "gallery", id: "harbor", variant: run },
				slides: [...d.session.deck.slides]
			})

			command = Math.min(command, cpuMs() - start)
			expect(result.ok).toBe(true)

			const saving = cpuMs()
			const saved = await d.save()

			save = Math.min(save, cpuMs() - saving)
			expect(saved.result.kind).toBe("written")
		}

		Object.assign(task.meta, {
			perf: { commandCpuMs: { value: command, budget: COMMAND_BUDGET_MS }, saveCpuMs: { value: save, budget: SAVE_BUDGET_MS } }
		})
		expect(command).toBeLessThanOrEqual(COMMAND_BUDGET_MS)
		expect(save).toBeLessThanOrEqual(SAVE_BUDGET_MS)
	})
})
