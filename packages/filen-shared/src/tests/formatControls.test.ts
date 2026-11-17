import { describe, expect, it } from "vitest"
import { withoutFormatControls } from "@filen/shared/formatControls"

describe("withoutFormatControls", () => {
	it("takes out bidi and other format characters, keeping ZWNJ and ZWJ", () => {
		expect(withoutFormatControls("invoice‮fdp.exe")).toBe("invoicefdp.exe")
		expect(withoutFormatControls("a​b⁦c⁩﻿")).toBe("abc")
		expect(withoutFormatControls("‌‍")).toBe("‌‍")
	})
})
