import HarnessKit
import SwiftUI

/// A page attachment to open full screen: its id and the caption to title it with.
struct EmbedTarget: Identifiable, Equatable {
    let id: String
    let caption: String
}

/// A spec's embedded page (`[caption](attachment:<id>)` alone on its line, the attachment a page):
/// a caption bar with a full-screen button over the live page, sized to what the page reports
/// (EmbedSize). It isn't interactive until tapped, so a swipe over it still scrolls the spec; Done
/// on the caption bar hands touches back. Its web view loads when it comes near the screen and is
/// released when it scrolls far away (EmbedPage.live): each WKWebView is a process, and a long spec's
/// pages all alive would get the app killed. A page that fails to load shows the caption and the
/// full-screen button over a placeholder. Under snapshot tests (`\.snapshotNow`), where a web view
/// doesn't render, the placeholder stands in for the page.
struct MarkdownEmbedView: View {
    let id: String
    let caption: String
    let style: MarkdownStyle

    @Environment(BoardStore.self) private var store: BoardStore?
    @Environment(\.snapshotNow) private var fixedNow
    @Environment(\.displayScale) private var scale
    @State private var host: EmbedWebHost?
    @State private var size = EmbedSize()
    @State private var live = false
    @State private var active = false

    private var c: Palette { style.palette }

    /// A frame and the scroll view's visible part, in the embed's own space.
    private struct Placement: Equatable {
        var height: Double
        var viewTop: Double?
        var viewBottom: Double?
    }

    var body: some View {
        VStack(spacing: 0) {
            EmbedCaptionBar(caption: caption, palette: c, active: active, removed: style.removed,
                            done: { active = false }, fullScreen: { style.media.openPage(id, caption) })
            HairlineRule(color: c.border)
            page
                .frame(maxWidth: .infinity)
                .frame(height: host?.failed == true ? EmbedPlaceholder.failedHeight : size.height)
        }
        .background(c.bgSunken)
        .clipShape(.rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(active ? c.accent : c.border, lineWidth: active ? 1.5 : 1 / scale))
        .opacity(style.removed ? 0.55 : 1)
        .padding(.vertical, 2)
        .onGeometryChange(for: Placement.self) { geo in
            let view = geo.bounds(of: .scrollView)
            return Placement(height: geo.size.height, viewTop: view.map { Double($0.minY) }, viewBottom: view.map { Double($0.maxY) })
        } action: { p in
            // Outside a scroll view (a full-height sheet) the page is always on screen.
            let next = p.viewTop.map { EmbedPage.live(live, top: 0, bottom: p.height, viewTop: $0, viewBottom: p.viewBottom ?? $0) } ?? true
            if next != live { setLive(next) }
        }
        .onDisappear { setLive(false) }
    }

    @ViewBuilder private var page: some View {
        if let host, !host.failed {
            EmbedWebViewRepresentable(host: host, interactive: active)
                .overlay {
                    if !active {
                        // Taps start interacting; drags fall through to the spec's scroll view.
                        Color.clear
                            .contentShape(.rect)
                            .onTapGesture {
                                haptic(.tap)
                                active = true
                            }
                            .accessibilityElement()
                            .accessibilityLabel("Interactive page \(caption)")
                            .accessibilityHint("Double tap to interact")
                            .accessibilityAddTraits(.isButton)
                    }
                }
        } else {
            EmbedPlaceholder(caption: caption, palette: c, failed: host?.failed == true)
        }
    }

    private func setLive(_ next: Bool) {
        live = next
        if next {
            // Snapshot tests draw the placeholder; without a connection there's nothing to load.
            guard host == nil, fixedNow == nil, let client = store?.api else { return }
            let h = EmbedWebHost(id: id, client: client)
            h.onHeight = { reported in
                let after = size.after(reported, now: ProcessInfo.processInfo.systemUptime)
                if after != size { size = after }
            }
            host = h
        } else {
            host?.tearDown()
            host = nil
            active = false
        }
    }
}

/// The embed's top bar: a page icon, the caption, Done while the page takes touches, and the
/// full-screen button.
private struct EmbedCaptionBar: View {
    let caption: String
    let palette: Palette
    let active: Bool
    let removed: Bool
    let done: () -> Void
    let fullScreen: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "macwindow")
                .font(.scaled(size: 13))
                .foregroundStyle(palette.text3)
                .accessibilityHidden(true)
            Text(caption)
                .font(.scaled(size: 13, weight: .medium))
                .foregroundStyle(palette.text2)
                .strikethrough(removed, color: palette.red.opacity(0.7))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if active {
                Button("Done", action: done)
                    .font(.scaled(size: 13, weight: .semibold))
                    .foregroundStyle(palette.accentText)
                    .buttonStyle(.plain)
            }
            Button {
                haptic(.tap)
                fullScreen()
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.scaled(size: 13, weight: .semibold))
                    .foregroundStyle(palette.text2)
                    .frame(width: 30, height: 30)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Full screen")
            .accessibilityHint("Opens \(caption) full screen")
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .frame(minHeight: 34)
        .background(palette.bg)
    }
}

/// What shows where the page isn't: before it loads, after it fails, and in snapshot tests.
struct EmbedPlaceholder: View {
    let caption: String
    let palette: Palette
    var failed = false

    static let failedHeight: Double = 140

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: failed ? "exclamationmark.triangle" : "macwindow")
                .font(.scaled(size: 22))
                .foregroundStyle(palette.text3)
            Text(failed ? "Couldn't load this page" : "Interactive page")
                .font(.scaled(size: 13, weight: .medium))
                .foregroundStyle(palette.text2)
            if failed {
                Text("Try full screen, or open the spec on the Mac.")
                    .font(.scaled(size: 12))
                    .foregroundStyle(palette.text3)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(failed ? "Couldn't load \(caption)" : caption)
    }
}

/// A page full screen (an embed's full-screen button, or an inline link to a page): live and
/// interactive, filling the sheet under a bar with its caption and a close button.
struct EmbedFullScreen: View {
    let target: EmbedTarget
    let close: () -> Void

    @Environment(\.palette) private var c
    @Environment(BoardStore.self) private var store: BoardStore?
    @Environment(\.snapshotNow) private var fixedNow
    @State private var host: EmbedWebHost?

    var body: some View {
        NavigationStack {
            Group {
                if let host, !host.failed {
                    EmbedWebViewRepresentable(host: host)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    EmbedPlaceholder(caption: target.caption, palette: c, failed: host?.failed == true || (fixedNow == nil && store?.api == nil))
                }
            }
            .background(c.bg)
            .navigationTitle(target.caption)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        close()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
        .onAppear {
            guard host == nil, fixedNow == nil, let client = store?.api else { return }
            host = EmbedWebHost(id: target.id, client: client)
        }
        .onDisappear {
            host?.tearDown()
            host = nil
        }
    }
}
