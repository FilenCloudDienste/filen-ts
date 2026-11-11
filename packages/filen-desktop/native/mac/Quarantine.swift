import CoreServices
import Foundation

// What every download gets: LaunchServices adds the process's bundle id, the time and an event id, and sets the flags
// that make Gatekeeper check the item on first open, as for a browser's downloads.
private func quarantineProperties() -> [String: Any] {
	[kLSQuarantineAgentNameKey as String: "Filen", kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String]
}

// Marks each path (file or directory) as downloaded. Every path is tried; the result names the first failure and how
// many more failed, nil when all were marked.
func quarantine(_ paths: [String]) -> String? {
	let properties = quarantineProperties()
	var firstFailure: String?
	var failures = 0

	for path in paths {
		do {
			try (URL(fileURLWithPath: path) as NSURL).setResourceValue(properties, forKey: .quarantinePropertiesKey)
		} catch {
			failures += 1

			if firstFailure == nil {
				firstFailure = "\(path): \(error.localizedDescription)"
			}
		}
	}

	guard let firstFailure else {
		return nil
	}

	return failures > 1 ? "\(firstFailure) (and \(failures - 1) more)" : firstFailure
}
