// swift-tools-version: 6.2
// L0 logic tests for HarnessKit, through its public API only. Run by `bun run testing` (layer L0).
// A package of its own, so it needs no simulator and shares nothing with ios/HarnessKit/Tests.
import PackageDescription

let package = Package(
    name: "HarnessLogicTests",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "../../ios/HarnessKit")],
    targets: [
        .testTarget(
            name: "LogicTests",
            dependencies: [.product(name: "HarnessKit", package: "HarnessKit")],
            path: "Tests/LogicTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
