import SwiftUI

/// An elevated, hairline-bordered surface (kit Card).
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.palette) private var c

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .background(c.bgElev, in: .rect(cornerRadius: 12))
            .clipShape(.rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
    }
}

/// A tinted message box with an icon, an optional bold title, and a body (kit Callout). A string
/// body is selectable, so error text can be copied; `content` is a body of any other kind
/// (markdown, say), under the message.
struct Callout<Content: View, Trailing: View>: View {
    let tone: Tone
    let icon: String
    var title: String?
    var message: String?
    @ViewBuilder var content: Content
    @ViewBuilder var trailing: Trailing

    @Environment(\.palette) private var c

    var body: some View {
        let t = c.tone(tone)
        HStack(alignment: .top, spacing: 10) {
            Icon(icon, size: 16, weight: .semibold).foregroundStyle(t.fg).padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                if let title { Text(title).font(.scaled(size: 14, weight: .semibold)).foregroundStyle(t.fg) }
                if let message {
                    Text(message).font(.scaled(size: 14)).foregroundStyle(c.text).lineSpacing(3).textSelection(.enabled)
                }
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(12)
        .background(t.bg, in: .rect(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

extension Callout where Content == EmptyView {
    init(tone: Tone, icon: String, title: String? = nil, message: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.init(tone: tone, icon: icon, title: title, message: message, content: { EmptyView() }, trailing: trailing)
    }
}

extension Callout where Content == EmptyView, Trailing == EmptyView {
    init(tone: Tone, icon: String, title: String? = nil, message: String? = nil) {
        self.init(tone: tone, icon: icon, title: title, message: message, content: { EmptyView() }, trailing: { EmptyView() })
    }
}

extension Callout where Trailing == EmptyView {
    init(tone: Tone, icon: String, title: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(tone: tone, icon: icon, title: title, message: nil, content: content, trailing: { EmptyView() })
    }
}

/// An empty state: `ContentUnavailableView` with a shared icon, in the theme's muted colors.
struct EmptyState<Actions: View>: View {
    var icon: String?
    var title: String
    var message: String?
    @ViewBuilder var actions: Actions

    @Environment(\.palette) private var c

    var body: some View {
        ContentUnavailableView {
            if let icon { Label(title, icon: icon) } else { Text(title) }
        } description: {
            if let message { Text(message) }
        } actions: {
            actions
        }
        .foregroundStyle(c.text3)
    }
}

extension EmptyState where Actions == EmptyView {
    init(icon: String? = nil, title: String, message: String? = nil) {
        self.init(icon: icon, title: title, message: message) { EmptyView() }
    }
}

struct Spinner: View {
    var color: Color?
    var large = false
    @Environment(\.palette) private var c

    var body: some View {
        ProgressView().controlSize(large ? .large : .regular).tint(color ?? c.text3)
    }
}

/// A screen-sized spinner on the theme background (RN requireStore's loading view).
struct LoadingScreen: View {
    @Environment(\.palette) private var c

    var body: some View {
        Spinner().frame(maxWidth: .infinity, maxHeight: .infinity).background(c.bg)
    }
}

/// An uppercase section label (kit SectionTitle).
struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    @Environment(\.palette) private var c

    var body: some View {
        Text(text.uppercased()).font(.scaled(size: 12.5, weight: .semibold)).tracking(0.4).foregroundStyle(c.text3)
    }
}
