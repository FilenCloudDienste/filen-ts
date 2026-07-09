import type { Page } from "@playwright/test"
import { expect } from "../fixtures"
import { SW_PROTOCOL_VERSION } from "@/lib/sw/protocol"

// Polls the synthetic version endpoint until the worker has activated and claimed the page — the
// proven readiness signal every service-worker-dependent spec builds on.
export async function waitForSwReady(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(async () => {
					try {
						const res = await fetch("/__sw/version")

						return res.ok ? ((await res.json()) as unknown) : null
					} catch {
						return null
					}
				}),
			{ timeout: 30_000 }
		)
		.toEqual({ v: SW_PROTOCOL_VERSION })
}
