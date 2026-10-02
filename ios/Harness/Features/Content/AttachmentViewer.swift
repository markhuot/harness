import AVFoundation
import AVKit
import HarnessKit
import SwiftUI

/// Full-screen pager over the attachments in a piece of markdown: ✕,
/// the file name and "2 of 4 · 1.2 MB" on top; pages swipe sideways (a select haptic each),
/// images pinch-zoom 1–4× or double-tap to 2.5× (paging stops while zoomed), videos play with the
/// system controls while their page shows, and pulling a page down (or ✕) closes it.
struct AttachmentViewer: View {
    let attachments: [Attachment]
    let onClose: () -> Void

    @State private var position: Int?
    @State private var zoomed = false
    @State private var pull = AttachmentViewerPull()
    @State private var shown = false
    @State private var closing = false
    @State private var slide: CGFloat = 0

    // Hosted pages don't inherit the environment, so the viewer hands them these.
    @Environment(BoardStore.self) private var store: BoardStore?
    @Environment(\.palette) private var c

    init(attachments: [Attachment], start: Int, onClose: @escaping () -> Void) {
        self.attachments = attachments
        self.onClose = onClose
        _position = State(initialValue: Attachments.clampPage(Double(start), count: attachments.count))
    }

    private var index: Int { position ?? 0 }

    var body: some View {
        GeometryReader { geo in
            let safe = geo.safeAreaInsets
            let header = safe.top + 56
            ZStack(alignment: .top) {
                AttachmentViewerBackdrop(pull: pull, height: geo.size.height)
                // A UIKit paging scroll view (AttachmentPager): the pages, a video's
                // player included, sit inside it, so its pan gets every sideways swipe.
                AttachmentPager(
                    count: attachments.count,
                    index: index,
                    scrollEnabled: !(zoomed || closing),
                    page: { i in
                        AnyView(
                            page(attachments[i], current: i == index, insets: UIEdgeInsets(top: header, left: 0, bottom: safe.bottom, right: 0), height: geo.size.height + safe.top + safe.bottom)
                                .environment(\.palette, c)
                                .modifier(AttachmentStoreEnvironment(store: store))
                                .ignoresSafeArea()
                        )
                    },
                    onPage: { position = $0 }
                )
                .ignoresSafeArea()
                .offset(y: slide)
                AttachmentViewerHeader(attachments: attachments, index: index, pull: pull, close: close)
                    .padding(.top, safe.top)
                    .frame(height: header, alignment: .bottom)
                    .ignoresSafeArea(edges: .top)
            }
            .onChange(of: position) { _, _ in
                haptic(.select)
                zoomed = false
            }
        }
        .opacity(shown ? 1 : 0)
        .background(Color.clear)
        .presentationBackground(.clear)
        .preferredColorScheme(.dark)
        .statusBarHidden(false)
        .onAppear { withAnimation(.easeOut(duration: 0.2)) { shown = true } }
    }

    @ViewBuilder
    private func page(_ a: Attachment, current: Bool, insets: UIEdgeInsets, height: CGFloat) -> some View {
        let events = AttachmentPageEvents(
            onPull: { dy in if !closing { pull.value = dy } },
            onRelease: { dismiss in if dismiss { swipeClose(height: height) } },
            onZoom: { z in if current { zoomed = z } }
        )
        if a.kind == .video {
            AttachmentVideoPage(attachment: a, current: current, insets: insets, events: events)
        } else {
            AttachmentImagePage(attachment: a, insets: insets, events: events)
        }
    }

    /// ✕: fade out, then close.
    private func close() {
        guard !closing else { return }
        closing = true
        withAnimation(.easeIn(duration: 0.18)) { shown = false } completion: { onClose() }
    }

    /// A pull far or fast enough: the page slides away as the backdrop fades.
    private func swipeClose(height: CGFloat) {
        guard !closing else { return }
        closing = true
        haptic(.tap)
        withAnimation(.easeIn(duration: 0.2)) {
            slide = height
            pull.value = height
        } completion: { onClose() }
    }
}

/// Puts the store (when there is one) into a hosted page's environment.
private struct AttachmentStoreEnvironment: ViewModifier {
    let store: BoardStore?

    func body(content: Content) -> some View {
        if let store { content.environment(store) } else { content }
    }
}

/// How far the current page is pulled down. Only the backdrop and header read it, so a pull
/// redraws them and not the pager.
@MainActor
@Observable
final class AttachmentViewerPull {
    var value: CGFloat = 0
}

private struct AttachmentViewerBackdrop: View {
    let pull: AttachmentViewerPull
    let height: CGFloat

    var body: some View {
        // Black at rest, 15% at half the screen's height.
        let t = height > 0 ? min(1, max(0, pull.value / (height * 0.5))) : 0
        Color.black.opacity(1 - 0.85 * t).ignoresSafeArea()
    }
}

private struct AttachmentViewerHeader: View {
    let attachments: [Attachment]
    let index: Int
    let pull: AttachmentViewerPull
    let close: () -> Void

    var body: some View {
        let current = attachments.indices.contains(index) ? attachments[index] : nil
        HStack(spacing: 8) {
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.scaled(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(.white.opacity(0.14), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            VStack(spacing: 1) {
                if let current {
                    Text(current.name)
                        .font(.scaled(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                    // Markdown attachments come without a size (0): only the position, then.
                    Text([attachments.count > 1 ? "\(index + 1) of \(attachments.count)" : "", current.size > 0 ? Attachments.formatSize(Double(current.size)) : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.scaled(size: 12.5))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            Color.clear.frame(width: 36, height: 36)
        }
        .padding(.horizontal, 8)
        .frame(height: 56)
        // The chrome fades out over the first 60 pt of a pull.
        .opacity(1 - min(1, max(0, pull.value / 60)))
    }
}

/// One image fitted to the page; it zooms in its page's scroll view.
private struct AttachmentImagePage: View {
    let attachment: Attachment
    let insets: UIEdgeInsets
    let events: AttachmentPageEvents

    @Environment(BoardStore.self) private var store: BoardStore?
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        let url = AttachmentMedia.url(store, attachment.id)
        Group {
            if failed {
                AttachmentHostedPage(insets: insets, events: events) { AttachmentFailed(name: attachment.name, dark: true) }
            } else if let image = image ?? url.flatMap({ AttachmentMedia.shared.cached($0) }) {
                AttachmentPage(content: .image(image, dims: dims(image)), insets: insets, events: events)
                    .accessibilityElement()
                    .accessibilityLabel(attachment.accessibilityName)
                    .accessibilityAddTraits(.isImage)
            } else {
                AttachmentHostedPage(insets: insets, events: events) { Color.white.opacity(0.04) }
            }
        }
        .task(id: url) {
            guard let url, image == nil else { return }
            do { image = try await AttachmentMedia.shared.image(url) } catch { if !Task.isCancelled { failed = true } }
        }
    }

    /// The service's size for it, else the decoded image's own pixels.
    private func dims(_ image: UIImage) -> AttachmentDimensions {
        let d = AttachmentDimensions(attachment)
        if let w = d.width, let h = d.height, w > 0, h > 0 { return d }
        return AttachmentDimensions(kind: .image, width: image.size.width * image.scale, height: image.size.height * image.scale)
    }
}

/// A video with the system's controls; only the showing page holds a player, so paging away
/// stops it, and it starts playing when its page comes into view. No picture in picture.
private struct AttachmentVideoPage: View {
    let attachment: Attachment
    let current: Bool
    let insets: UIEdgeInsets
    let events: AttachmentPageEvents

    @Environment(BoardStore.self) private var store: BoardStore?
    @State private var holder = AttachmentPlayerHolder()
    @State private var failed = false

    var body: some View {
        // One view for the page's whole life (the player view controller stays put as the page
        // comes and goes). The placeholder and the failure draw on top.
        AttachmentPage(content: .controller(holder.controller), insets: insets, events: events)
            .accessibilityLabel(attachment.accessibilityName)
            .overlay {
                Group {
                    if failed {
                        AttachmentFailed(name: attachment.name, dark: true)
                    } else if !current {
                        Image(systemName: "play.fill").font(.system(size: 30)).foregroundStyle(.white.opacity(0.6))
                    }
                }
                .allowsHitTesting(false)
            }
            .task(id: current) {
                guard current, !failed, let url = AttachmentMedia.url(store, attachment.id).flatMap(URL.init(string:)) else {
                    holder.stop()
                    return
                }
                guard let item = holder.play(url) else { return }
                for await status in item.publisher(for: \.status).values where status == .failed {
                    failed = true
                    holder.stop()
                    return
                }
            }
            .onDisappear { holder.stop() }
    }
}

/// A video page's AVPlayerViewController (system controls, no picture in picture). It holds a
/// player only while its page shows, so paging away stops the video.
@MainActor
final class AttachmentPlayerHolder {
    private var made: AVPlayerViewController?

    var controller: AVPlayerViewController {
        if let made { return made }
        let vc = AVPlayerViewController()
        vc.allowsPictureInPicturePlayback = false
        vc.canStartPictureInPictureAutomaticallyFromInline = false
        vc.showsPlaybackControls = true
        vc.videoGravity = .resizeAspect
        // Live Text on video frames adds an interaction that can take a sideways swipe, which then
        // doesn't page the viewer off the video.
        vc.allowsVideoFrameAnalysis = false
        vc.view.backgroundColor = .clear
        made = vc
        return vc
    }

    /// Starts `url` from the top and returns its item.
    func play(_ url: URL) -> AVPlayerItem? {
        let player = AVPlayer(url: url)
        controller.player = player
        player.play()
        return player.currentItem
    }

    func stop() {
        made?.player?.pause()
        made?.player = nil
    }
}

/// A SwiftUI view filling a pull-to-close page.
private struct AttachmentHostedPage<Content: View>: View {
    let insets: UIEdgeInsets
    let events: AttachmentPageEvents
    @ViewBuilder let content: Content

    @State private var host: UIHostingController<Content>?

    var body: some View {
        Group {
            if let host {
                AttachmentPage(content: .controller(host), insets: insets, events: events)
            } else {
                Color.clear
            }
        }
        .onAppear {
            guard host == nil else { return }
            let h = UIHostingController(rootView: content)
            h.view.backgroundColor = .clear
            host = h
        }
    }
}

/// Which attachment the viewer opens on.
struct AttachmentViewerStart: Identifiable {
    let index: Int
    var id: Int { index }
}

extension Attachment {
    /// "Image phone.png" / "Video flow.mp4": the page's accessibility label.
    var accessibilityName: String { "\(kind == .video ? "Video" : "Image") \(name)" }
}
