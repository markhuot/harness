import SwiftUI
import UIKit

/// Pads a scrolling form's bottom safe area by however much of it the on-screen keyboard covers,
/// so it can scroll its last rows (and a growing field's cursor, PromptTextEditor.followCaret) up
/// above the keyboard. New session's form in the iPhone's ticket sheet (TicketSheetLayer) never
/// gets the keyboard in its safe area: its scroll view's bottom inset stays at the home indicator's
/// with the keyboard up, so the form had nowhere to scroll to and the cursor went behind it.
///
/// Where SwiftUI does avoid the keyboard, the form already ends above it and this adds nothing.
/// Once the keyboard is up it scrolls the focused text view's cursor into sight, since the room to
/// do that only appears with the padding.
struct KeyboardOverlapPadding: ViewModifier {
    /// The keyboard's frame in screen coordinates (nil: down)
    @State private var keyboard: CGRect?
    /// The form's frame in the window
    @State private var frame: CGRect = .zero

    func body(content: Content) -> some View {
        content
            .safeAreaPadding(.bottom, overlap)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { n in
                let end = n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
                // A keyboard leaving slides below the screen; a floating one is a small frame
                // that covers no full width.
                keyboard = end.flatMap { $0.height > 0 ? $0 : nil }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = nil }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                if let v = FocusedTextView.current() { PromptTextEditor.followCaret(v) }
            }
    }

    private var overlap: CGFloat {
        guard let keyboard, keyboard.width >= frame.width else { return 0 }
        return max(0, frame.maxY - keyboard.minY)
    }
}

extension View {
    /// See KeyboardOverlapPadding.
    func keyboardOverlapPadding() -> some View { modifier(KeyboardOverlapPadding()) }
}
