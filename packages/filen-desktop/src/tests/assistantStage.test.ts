import { describe, expect, it } from "vitest"
import { backendPackages } from "../../scripts/stageLlama.ts"

// Which of node-llama-cpp's prebuilt packages ship with each <os>-<arch> build: every one published for it but CUDA's,
// none of another architecture's.

const INSTALLED = [
	"linux-arm64",
	"linux-x64",
	"linux-x64-cuda",
	"linux-x64-cuda-ext",
	"linux-x64-vulkan",
	"mac-arm64-metal",
	"mac-x64",
	"win-arm64",
	"win-x64",
	"win-x64-cuda",
	"win-x64-cuda-ext",
	"win-x64-vulkan"
]

describe("assistant engine staging", () => {
	it("ships every backend published for the build's OS and CPU, but CUDA's", () => {
		expect(backendPackages(INSTALLED, "mac", "arm64")).toEqual(["mac-arm64-metal"])
		expect(backendPackages(INSTALLED, "mac", "x64")).toEqual(["mac-x64"])
		expect(backendPackages(INSTALLED, "win", "x64")).toEqual(["win-x64", "win-x64-vulkan"])
		expect(backendPackages(INSTALLED, "win", "arm64")).toEqual(["win-arm64"])
		expect(backendPackages(INSTALLED, "linux", "x64")).toEqual(["linux-x64", "linux-x64-vulkan"])
		expect(backendPackages(INSTALLED, "linux", "arm64")).toEqual(["linux-arm64"])
	})

	it("never mistakes another architecture's package for one of this build", () => {
		expect(backendPackages(["linux-x64", "linux-x64v2"], "linux", "x64")).toEqual(["linux-x64"])
		expect(backendPackages(["linux-armv7l"], "linux", "arm")).toEqual([])
	})
})
