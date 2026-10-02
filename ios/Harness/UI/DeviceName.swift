import UIKit

/// "iPhone" / "iPad", for copy that names the device.
@MainActor var deviceName: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
