import UIKit

/// "iPhone" / "iPad" (lib/device.ts DEVICE), for copy that names the device.
@MainActor var deviceName: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
