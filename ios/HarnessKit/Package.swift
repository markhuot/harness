// swift-tools-version: 6.2
// Portable logic for the native app: protocol models, client, state and pure helpers.
// Foundation only (no UIKit/SwiftUI) so `swift test` runs on the macOS host.
import PackageDescription

let package = Package(
    name: "HarnessKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [
        .library(name: "HarnessKit", targets: ["HarnessKit"]),
        .library(name: "HarnessHighlight", targets: ["HarnessHighlight"]),
    ],
    targets: [
        .target(
            name: "HarnessKit",
            path: "Sources/HarnessKit",
            resources: [.process("Resources")]
        ),
        // Syntax highlighting: Shiki in JavaScriptCore (ARCHITECTURE.md § Syntax highlighting).
        // Its own target so only code that highlights links JavaScriptCore. The script itself
        // isn't a resource here: it's generated (ios/Tools/build-highlighter.ts) and handed in.
        .target(
            name: "HarnessHighlight",
            dependencies: ["HarnessKit"],
            path: "Sources/HarnessHighlight"
        ),
        .testTarget(
            name: "HarnessKitTests",
            dependencies: ["HarnessKit", "HarnessHighlight"],
            path: "Tests/HarnessKitTests",
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
