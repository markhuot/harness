import HarnessKit
import SwiftUI

extension EnvironmentValues {
    /// How a foldable is held (the iPhone Duo's hinge), `.flat` where there is no hinge or it is fully
    /// open. The root reads the hinge (`DevicePostureReader`); a screen test can set it directly.
    @Entry var devicePosture = DevicePosture.flat
}

extension View {
    /// Reports the hinge's posture to everything below (and so to the sheets this presents).
    func readsDevicePosture() -> some View { modifier(DevicePostureReader()) }

    /// The sheet's sizing and placement: the form sheet, placed by the system, or in the Duo's book
    /// pose on the trailing side (`presentationPlacement`, iOS 27), the right half of the screen.
    @ViewBuilder func ticketSheetPresentation(_ placement: TicketSheetPlacement, regularWidth: Bool) -> some View {
        // Form sizing only at regular width: at compact width it would drop the phone sheet's
        // rounded bottom corners.
        let sized = regularWidth ? AnyView(presentationSizing(.form)) : AnyView(self)
        if #available(iOS 27.0, *) {
            sized.presentationPlacement(placement == .trailing ? .trailing : .automatic)
        } else {
            sized
        }
    }
}

/// Watches the hinge (iOS 27.1) and the window's shape, and puts the posture in the environment.
/// Without a hinge update it passes the inherited posture through, so a test's value stands.
private struct DevicePostureReader: ViewModifier {
    @Environment(\.devicePosture) private var inherited
    @State private var partlyOpen: Bool?
    @State private var size = CGSize.zero

    private var posture: DevicePosture {
        guard let partlyOpen else { return inherited }
        return .resolve(hingePartlyOpen: partlyOpen, windowWidth: size.width, windowHeight: size.height)
    }

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .modifier(HingeWatcher(partlyOpen: $partlyOpen))
            .environment(\.devicePosture, posture)
    }
}

private struct HingeWatcher: ViewModifier {
    @Binding var partlyOpen: Bool?

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, new in
                partlyOpen = new.hinge.map { $0.status == .partiallyOpen }
            }
        } else {
            content
        }
    }
}
