import { desktopBridge, desktopPlatform } from "@/lib/desktop"
import type { MountsOffer } from "@/features/mounts/lib/mountsRoles"

// What Mounts offers in this session. The bridge never changes mid-session, so it is read once.
export const MOUNTS_OFFER: MountsOffer = { platform: desktopPlatform(), finder: desktopBridge()?.fileProvider.supported === true }
