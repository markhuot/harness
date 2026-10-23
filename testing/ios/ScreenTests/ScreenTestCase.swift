import HarnessKit
import SwiftUI
import XCTest
@testable import Harness

/// The base of every screen test: a fresh world per test, the world's time zone, and no state left
/// over in UserDefaults from another test or from real use of this simulator.
@MainActor
class ScreenTestCase: XCTestCase {
    var world: ScreenWorld!
    private var savedTimeZone: TimeZone!

    override func setUp() async throws {
        continueAfterFailure = true
        Self.resetPersistedState()
        let json = try WorldJSON.load()
        savedTimeZone = NSTimeZone.default
        NSTimeZone.default = json.timeZone
        world = await ScreenWorld(json)
    }

    override func tearDown() async throws {
        // A screen that asked for something the world doesn't hold: loud, not a quiet blank.
        XCTAssertEqual(world.transport.unrouted, [], "the world has no route for these requests")
        NSTimeZone.default = savedTimeZone
        Self.resetPersistedState()
        // A landscape render turned the scene; the next test starts upright.
        try await Renderer.rotate(landscape: false)
    }

    /// RootView saves and restores what the user left open (the docked tickets) and a few view
    /// settings in UserDefaults, so a screen would otherwise render whatever the last test left.
    static func resetPersistedState() {
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Router.persistedStatePrefix) { defaults.removeObject(forKey: key) }
        for key in [Router.persistedDockKey, "planUsageFilter", "planUsageMode", "browserSizeRowOpen", "harness.git.viewed", "harness.git.diffStyle", PaletteCommandRecents.key, PaletteRecents.filesKey] {
            defaults.removeObject(forKey: key)
        }
    }

    /// Renders `content` in `world` (this test's, unless another is given) and returns the image.
    func render<V: View>(_ world: ScreenWorld? = nil, router: Router = Router(), dark: Bool = false, landscape: Bool = false, regularWidth: Bool = false, requiresTrailingInset: Bool = false, @ViewBuilder _ content: () -> V) async throws -> UIImage {
        let w = world ?? self.world!
        Self.resetPersistedState()
        return try await Renderer.render(w.environment(content(), router: router, scheme: dark ? .dark : .light), world: w, dark: dark, landscape: landscape, regularWidth: regularWidth, requiresTrailingInset: requiresTrailingInset)
    }

    /// Renders `content` and checks it against its reference image.
    func screen<V: View>(_ name: String, router: Router = Router(), landscape: Bool = false, regularWidth: Bool = false, requiresTrailingInset: Bool = false, file: StaticString = #filePath, line: UInt = #line, @ViewBuilder _ content: () -> V) async throws {
        do {
            let image = try await render(router: router, landscape: landscape, regularWidth: regularWidth, requiresTrailingInset: requiresTrailingInset, content)
            ReferenceImages.assert(image, named: name, file: file, line: line)
        } catch {
            XCTFail("\(name): render threw \(type(of: error)): \(String(reflecting: error))", file: file, line: line)
        }
    }
}
