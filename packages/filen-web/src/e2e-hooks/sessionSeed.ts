// The page binding the e2e harness serves a session blob through (page.exposeBinding). A binding, not an
// init script or a storage slot: a binding's answer is not a recorded call argument, so the blob stays out
// of traces. Its own module so bootSdk can read it without importing the hooks module — that import would
// pull the whole test surface into the production graph, which the no-flag build grep (tests.yml) forbids.
export const SESSION_BINDING = "__filenE2ESession"

// The harness's blob for this navigation, or null when it serves none.
export async function takeSeededSession(): Promise<string | null> {
	const serve: unknown = Reflect.get(window, SESSION_BINDING)

	if (typeof serve !== "function") {
		return null
	}

	const seeded: unknown = await (serve as () => Promise<unknown>)()

	return typeof seeded === "string" ? seeded : null
}
