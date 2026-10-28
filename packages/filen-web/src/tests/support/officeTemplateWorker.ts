import * as Comlink from "comlink"
import { officeTemplateApi } from "@/features/drive/lib/officeTemplates"

// officeTemplate.worker.ts in-process: its API served over a MessageChannel (the bytes cross a real structured-clone
// boundary). For `vi.mocked(OfficeTemplateWorker).mockImplementation(inProcessTemplateWorker(onTerminate))` with the
// `?worker` import mocked to a vi.fn().
export function inProcessTemplateWorker(onTerminate: () => void = () => undefined): () => Worker {
	return function () {
		const { port1, port2 } = new MessageChannel()

		Comlink.expose(officeTemplateApi, port2)

		return Object.assign(port1, {
			terminate: () => {
				onTerminate()
				port1.close()
				port2.close()
			}
		}) as unknown as Worker
	}
}
