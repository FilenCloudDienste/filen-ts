import { describe, expect, it } from "vitest"
import { serialQueue } from "../main/serial.ts"

describe("serialQueue", () => {
	it("runs one operation at a time, in call order", async () => {
		const serial = serialQueue()
		const events: string[] = []
		const step = (name: string, ms: number) =>
			serial(async () => {
				events.push(`start ${name}`)
				await new Promise(resolve => setTimeout(resolve, ms))
				events.push(`end ${name}`)

				return name
			})

		await expect(Promise.all([step("a", 10), step("b", 0)])).resolves.toEqual(["a", "b"])
		expect(events).toEqual(["start a", "end a", "start b", "end b"])
	})

	it("keeps going after a failure, which only its own caller sees", async () => {
		const serial = serialQueue()
		const failed = serial(() => Promise.reject(new Error("boom")))
		const next = serial(() => Promise.resolve(1))

		await expect(failed).rejects.toThrow("boom")
		await expect(next).resolves.toBe(1)
	})
})
