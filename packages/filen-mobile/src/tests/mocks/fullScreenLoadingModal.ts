/**
 * runWithLoading is run() plus the show/hide modal events, so the mock is the faithful run() from the
 * shared @filen/shared mock.
 *
 *   vi.mock("@/components/ui/fullScreenLoadingModal", async () => await import("@/tests/mocks/fullScreenLoadingModal"))
 */

import { vi } from "vitest"
import { run } from "@/tests/mocks/filenShared"

export const runWithLoading = vi.fn(run)
