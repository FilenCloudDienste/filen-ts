import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-image-manipulator", () => ({
	ImageManipulator: {
		manipulate: vi.fn()
	},
	SaveFormat: {
		JPEG: "jpeg",
		WEBP: "webp"
	}
}))

import * as ImageManipulator from "expo-image-manipulator"
import { renderAndSave } from "@/lib/imageManipulator"

function mockContext(saveAsync: () => Promise<{ uri: string }>) {
	const rendered = {
		saveAsync: vi.fn(saveAsync),
		release: vi.fn()
	}

	const context = {
		renderAsync: vi.fn(async () => rendered),
		resize: vi.fn(),
		release: vi.fn()
	}

	context.resize.mockReturnValue(context)

	vi.mocked(ImageManipulator.ImageManipulator.manipulate).mockReturnValue(
		context as unknown as ReturnType<typeof ImageManipulator.ImageManipulator.manipulate>
	)

	return {
		context,
		rendered
	}
}

describe("renderAndSave", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders, saves without base64 and releases both native objects", async () => {
		const { context, rendered } = mockContext(async () => ({ uri: "file:///cache/out.jpg" }))

		const result = await renderAndSave("file:///cache/in.heic", {
			format: ImageManipulator.SaveFormat.JPEG,
			compress: 0.8
		})

		expect(result.uri).toBe("file:///cache/out.jpg")
		expect(ImageManipulator.ImageManipulator.manipulate).toHaveBeenCalledWith("file:///cache/in.heic")
		expect(context.resize).not.toHaveBeenCalled()
		expect(rendered.saveAsync).toHaveBeenCalledWith({ format: "jpeg", compress: 0.8, base64: false })
		expect(rendered.release).toHaveBeenCalledTimes(1)
		expect(context.release).toHaveBeenCalledTimes(1)
	})

	it("resizes to the given width before rendering", async () => {
		const { context } = mockContext(async () => ({ uri: "file:///cache/out.webp" }))

		await renderAndSave("file:///cache/frame.jpg", { format: ImageManipulator.SaveFormat.WEBP }, 256)

		expect(context.resize).toHaveBeenCalledWith({ width: 256 })
	})

	it("releases both native objects when saving fails", async () => {
		const { context, rendered } = mockContext(async () => {
			throw new Error("save failed")
		})

		await expect(renderAndSave("file:///cache/in.png", { format: ImageManipulator.SaveFormat.JPEG })).rejects.toThrow("save failed")

		expect(rendered.release).toHaveBeenCalledTimes(1)
		expect(context.release).toHaveBeenCalledTimes(1)
	})

	it("releases the context when rendering fails", async () => {
		const { context } = mockContext(async () => ({ uri: "file:///cache/out.jpg" }))

		context.renderAsync.mockRejectedValueOnce(new Error("decode failed"))

		await expect(renderAndSave("file:///cache/in.png", { format: ImageManipulator.SaveFormat.JPEG })).rejects.toThrow("decode failed")

		expect(context.release).toHaveBeenCalledTimes(1)
	})
})
