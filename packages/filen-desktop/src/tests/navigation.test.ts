import { describe, expect, it } from "vitest"
import { classifyNavigation, isTrustedSender } from "../main/navigation.ts"

const APP = "filen://app"

describe("classifyNavigation", () => {
	it.each([
		["filen://app/drive/abc", "inApp"],
		["https://filen.io/pricing", "external"],
		["mailto:support@filen.io", "external"],
		["http://example.com/", "external"],
		["tel:+491234", "deny"],
		["whatsapp://send?text=x", "deny"],
		["filen://evil/", "deny"],
		["javascript:alert(1)", "deny"],
		["file:///etc/passwd", "deny"],
		["not a url", "deny"]
	] as const)("%s → %s", (url, verdict) => {
		expect(classifyNavigation(url, APP)).toBe(verdict)
	})
})

describe("isTrustedSender", () => {
	it("accepts only the app origin", () => {
		expect(isTrustedSender("filen://app/login", APP)).toBe(true)
		expect(isTrustedSender("https://app.filen.io/", APP)).toBe(false)
		expect(isTrustedSender("filen://evil/", APP)).toBe(false)
		expect(isTrustedSender(undefined, APP)).toBe(false)
	})
})
