import { OFFICE_FONT_URLS } from "virtual:office-fonts"
import { workerRealm } from "@filen/office/dom/presentation"
import { servePresentationDeckWorker } from "@/features/presentation/workers/presentationScope"

// The presentation worker (one per open deck): the package, the model, every text layout, rendering, edits, history
// and saving run here, served over @filen/office's presentation protocol (presentationScope.ts). Text is measured and
// drawn with the bundled faces, fetched on demand from the app's own origin.
servePresentationDeckWorker(self, { realm: workerRealm(self, OFFICE_FONT_URLS) })
