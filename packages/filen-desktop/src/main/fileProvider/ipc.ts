import { type } from "arktype"
import { type FileProviderCall, fileProviderChannel } from "../../shared/channels.ts"
import { type CheckedCall, checkedCalls, type IpcMain, registerCalls } from "../pages.ts"
import type { FileProviderService } from "./service.ts"

const call = checkedCalls<FileProviderService>("file provider")

const CALLS: Record<FileProviderCall, CheckedCall<FileProviderService>> = {
	state: call(type([]), service => service.state()),
	enable: call(type([]), service => service.enable()),
	disable: call(type([]), service => service.disable())
}

// Every request answers the app's own top-level document only and takes no arguments.
export function registerFileProviderIpc(
	ipc: IpcMain,
	service: FileProviderService,
	trusted: (senderUrl: string | undefined) => boolean
): void {
	registerCalls(ipc, CALLS, fileProviderChannel, service, trusted)
}
