import "@/lib/polyfills/DOMException"
import "@/lib/polyfills/buffer"
import "@/lib/polyfills/crypto"
import "@/lib/polyfills/console"

import NetInfo from "@react-native-community/netinfo"
import { NETINFO_CONFIG } from "@/constants"
import { enableFreeze } from "react-native-screens"
import { installGlobalErrorHandlers } from "@/lib/errorHandlers"

// Route uncaught JS errors + unhandled promise rejections to the on-disk diagnostic logger
// (after the console tee is installed above). In production these are otherwise invisible.
installGlobalErrorHandlers()

enableFreeze(true)

NetInfo.configure(NETINFO_CONFIG)
