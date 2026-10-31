import { describe, expect, it } from "vitest"
import { encodePowerShell } from "../../scripts/ci/support.ts"

describe("encodePowerShell", () => {
	it("round-trips the script as UTF-16LE base64, stopping on errors and exiting 0 after it", () => {
		const script = "(Get-AuthenticodeSignature -FilePath 'C:\\Program Files\\Filen\\Filen.exe').Status; \"$($p.DisplayVersion)|`t\""
		const decoded = Buffer.from(encodePowerShell(script), "base64").toString("utf16le")
		const lines = decoded.split("\n")

		expect(lines[0]).toBe("$ErrorActionPreference = 'Stop'")
		expect(lines).toContain(script)
		expect(lines.indexOf(script)).toBeLessThan(lines.indexOf("exit 0"))
		expect(decoded.endsWith("exit 0\n")).toBe(true)
		expect(encodePowerShell(script)).toMatch(/^[A-Za-z0-9+/]+=*$/)
	})
})
