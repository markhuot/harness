// swift-tools-version: 6.2
// Portable logic for the native app: protocol models, client, state and pure helpers.
// Foundation only (no UIKit/SwiftUI) so `swift test` runs on the macOS host.
import PackageDescription

let package = Package(
    name: "HarnessKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [
        .library(name: "HarnessKit", targets: ["HarnessKit"]),
    ],
    targets: [
        .target(
            name: "HarnessKit",
            path: "Sources/HarnessKit",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "HarnessKitTests",
            dependencies: ["HarnessKit"],
            path: "Tests/HarnessKitTests",
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
