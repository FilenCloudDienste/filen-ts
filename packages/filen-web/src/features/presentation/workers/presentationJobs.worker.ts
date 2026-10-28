import { fontFaceHost } from "@filen/office/dom"
import { macrotaskYield } from "@filen/office/dom/docx"
import { offscreenCanvas, servePresentationJobsWorker } from "@filen/office/dom/presentation"
import { officePdfFontAssets } from "@/features/office/lib/pdfFontAssets"

// A presentation jobs worker (one per export, terminated afterwards): PDF of slides, notes pages or handouts, and
// slide images, reading the open session through a port to the presentation worker (unsaved edits included). The
// text is drawn in the faces the session laid it out in: registered here for the canvas, embedded (bundled ones,
// fetched from the app's origin) in a PDF.
const canvas = offscreenCanvas(self)

servePresentationJobsWorker(
	{
		postMessage: (message, transfer) => {
			self.postMessage(message, { transfer: transfer as Transferable[] })
		},
		addEventListener: (type, listener) => {
			self.addEventListener(type, listener)
		},
		removeEventListener: (type, listener) => {
			self.removeEventListener(type, listener)
		}
	},
	{
		assets: officePdfFontAssets,
		...(canvas === undefined ? {} : { canvas }),
		fonts: fontFaceHost(self),
		lang: navigator.language,
		slicing: { pause: macrotaskYield(), sliceMs: 50, now: () => performance.now() }
	}
)
