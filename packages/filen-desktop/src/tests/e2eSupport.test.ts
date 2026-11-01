import { describe, expect, it } from "vitest"
import { encodePowerShell, powershellErrorText, psQuote } from "../../scripts/ci/support.ts"

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

describe("psQuote", () => {
	it("makes a single-quoted literal that keeps quotes, dollars and backticks as they are", () => {
		expect(psQuote("C:\\Users\\runner\\it's $HOME `n")).toBe("'C:\\Users\\runner\\it''s $HOME `n'")
	})
})

describe("powershellErrorText", () => {
	it("reads the error records out of PowerShell's CLIXML stderr", () => {
		const clixml =
			'#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">no dialog titled &apos;x&apos;_x000D__x000A_</S>' +
			'<S S="Error">At line:3 char:1 &lt;here&gt;_x000D__x000A_</S></Objs>'

		expect(powershellErrorText(clixml)).toBe("no dialog titled 'x'\r\nAt line:3 char:1 <here>")
		expect(powershellErrorText("plain text\n")).toBe("plain text")
	})
})
