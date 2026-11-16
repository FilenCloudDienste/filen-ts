// The served build the suite runs against. E2E_PORT serves a second build beside one already on the default port (a
// reused server is the one there). A function: playwright.config.ts loads .env after its imports.
export function e2eBaseUrl(): string {
	return `http://localhost:${process.env["E2E_PORT"] ?? "4173"}`
}
