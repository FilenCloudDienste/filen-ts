// The sessionStorage switches an e2e lane sets before the app loads, read only by E2E builds. Shared by the app
// modules that read them and the Playwright harness that writes them, so it imports nothing and reads no
// import.meta.

// "off": no editor autosaves in this tab (features/office/lib/officeAutosave.ts), set by the read lanes.
export const E2E_AUTOSAVE_KEY = "filen-e2e-docx-autosave"

// "on": every PDF export is deterministic (features/office/lib/pdfTestMode.ts).
export const E2E_PDF_DETERMINISTIC_KEY = "filen-e2e-pdf-deterministic"
