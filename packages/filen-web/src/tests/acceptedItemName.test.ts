import { describe, expect, it, vi } from "vitest"

// A name from outside the drive made one the SDK takes: kept when it does, else sanitized, else prefixed.

const { itemNameErrors } = vi.hoisted(() => ({
	// The SDK's refusals, as far as these names go: forbidden characters, reserved device names, more than 255 bytes.
	itemNameErrors: vi.fn((names: string[]) =>
		Promise.resolve(
			names.map(name =>
				/[:/\\*?"<>|]/.test(name)
					? "ForbiddenChar"
					: /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)
						? "Reserved"
						: new TextEncoder().encode(name).length > 255
							? "TooLong"
							: null
			)
		)
	)
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { itemNameErrors } }))

const { acceptedItemName } = await import("@/features/drive/lib/archiveHelpers")

describe("acceptedItemName", () => {
	it("keeps a name the SDK takes", async () => {
		expect(await acceptedItemName("report.pdf")).toBe("report.pdf")
	})

	it("sanitizes a forwarded message's name", async () => {
		expect(await acceptedItemName("Re: Meeting.eml")).toBe("Re__Meeting.eml")
	})

	it("prefixes a reserved device name, which sanitizing keeps", async () => {
		expect(await acceptedItemName("CON")).toBe("_CON")
	})

	it("cuts a 300-byte name to 255 bytes, its extension kept", async () => {
		const name = await acceptedItemName(`${"a".repeat(296)}.txt`)

		expect(new TextEncoder().encode(name).length).toBe(255)
		expect(name.endsWith(".txt")).toBe(true)
	})

	it("keeps a prefixed reserved name within 255 bytes", async () => {
		const name = await acceptedItemName(`CON.${"b".repeat(251)}`)

		expect(name.startsWith("_CON.")).toBe(true)
		expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255)
	})

	it("still prefixes a reserved name when the SDK cannot be asked", async () => {
		itemNameErrors.mockRejectedValueOnce(new Error("worker gone"))

		expect(await acceptedItemName("NUL.txt")).toBe("_NUL.txt")
	})
})
