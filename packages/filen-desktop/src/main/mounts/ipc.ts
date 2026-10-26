import { type } from "arktype"
import type { DesktopCredentialProtocol, DesktopDrivePatch, DesktopServeCredentials, DesktopServePatch } from "@filen/shared/desktop"
import { CHANNELS, type MountsCall, mountsChannel, type MountsSubscription } from "../../shared/channels.ts"
import {
	basicAuthSchema,
	driveLetterSchema,
	listenHostSchema,
	pinned,
	portSchema,
	s3AuthSchema,
	serveProtocolSchema,
	vfsTuningSchema
} from "../../shared/nativeProtocol.ts"
import { type CheckedCall, checkedCalls, type IpcMain, pageOf, registerCalls } from "../pages.ts"
import { rootIdSchema } from "../sync/ipc.ts"
import { CREDENTIAL_PROTOCOLS } from "./credentials.ts"
import type { MountsService } from "./service.ts"
import { mountsNoticeSchema } from "./store.ts"

const credentialProtocolSchema = pinned<DesktopCredentialProtocol>()(type.enumerated(...CREDENTIAL_PROTOCOLS))

// A mount point travels as the id chooseMountPoint issued, never as a path.
const drivePatchSchema = pinned<DesktopDrivePatch>()(
	type({
		"enabled?": "boolean",
		"mountPointId?": rootIdSchema,
		"driveLetter?": driveLetterSchema,
		"readOnly?": "boolean",
		"+": "reject"
	})
)

const servePatchSchema = pinned<DesktopServePatch>()(
	type({
		"enabled?": "boolean",
		"address?": listenHostSchema,
		"port?": portSchema,
		"https?": "boolean",
		"readOnly?": "boolean",
		"acknowledgeUnauthenticated?": "boolean",
		"+": "reject"
	})
)

// rclone's own limits (no ":" in a basic credential, an alphanumeric s3 key id); credentialsProblem then judges the
// strength.
const credentialsSchema = pinned<DesktopServeCredentials>()(basicAuthSchema.or(s3AuthSchema))

const call = checkedCalls<MountsService>("mounts")

const CALLS: Record<MountsCall, CheckedCall<MountsService>> = {
	overview: call(type([]), service => service.overview()),
	stats: call(type([]), service => service.stats()),
	chooseMountPoint: call(type([]), service => service.chooseMountPoint()),
	driveLetters: call(type([]), service => service.driveLetters()),
	setDrive: call(type([drivePatchSchema]), (service, _page, [patch]) => service.setDrive(patch)),
	listenAddresses: call(type([]), service => service.listenAddresses()),
	setServe: call(type([serveProtocolSchema, servePatchSchema]), (service, _page, args) => service.setServe(...args)),
	credentials: call(type([credentialProtocolSchema]), (service, _page, [protocol]) => service.credentials(protocol)),
	copyCredential: call(type([credentialProtocolSchema, type("'user' | 'secret'")]), (service, _page, args) =>
		service.copyCredential(...args)
	),
	setCredentials: call(type([credentialProtocolSchema, credentialsSchema]), (service, _page, args) => service.setCredentials(...args)),
	regenerateCredentials: call(type([credentialProtocolSchema]), (service, _page, [protocol]) => service.regenerateCredentials(protocol)),
	setTuning: call(type([vfsTuningSchema]), (service, _page, [tuning]) => service.setTuning(tuning)),
	clearCache: call(type([]), service => service.clearCache()),
	installFuse: call(type([]), service => service.installFuse()),
	revealDrive: call(type([]), service => service.revealDrive()),
	confirmSignOut: call(type([]), service => service.confirmSignOut()),
	dismissNotice: call(type([mountsNoticeSchema]), (service, _page, [notice]) => service.dismissNotice(notice)),
	retryHost: call(type([]), service => {
		service.retryHost()
	})
}

const subscribeSchema = pinned<MountsSubscription>()(type({ overview: "boolean", stats: "boolean", "+": "reject" }))

// Every mounts request answers the app's own top-level document only, with arguments checked before the service sees
// them. Paths are never among them, and what a request answers (credentials among it) is never logged.
export function registerMountsIpc(ipc: IpcMain, service: MountsService, trusted: (senderUrl: string | undefined) => boolean): void {
	registerCalls(ipc, CALLS, mountsChannel, service, trusted)

	ipc.on(CHANNELS.mountsSubscribe, (event, subscription) => {
		const valid = subscribeSchema(subscription)

		if (trusted(event.senderFrame?.url) && !(valid instanceof type.errors)) {
			service.subscribe(pageOf(event.sender), valid)
		}
	})
}
