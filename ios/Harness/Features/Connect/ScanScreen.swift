@preconcurrency import AVFoundation
import HarnessKit
import SwiftUI
import UIKit

/// In-app QR scanner for the pairing code (screens/Scan.tsx): back camera, QR codes only. A bad
/// code says why (warning haptic); the same data isn't handled twice in a row (a failed pair
/// clears that, so the code can be retried); a good one pairs and goes to the Board.
struct ScanScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var permission = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var message: String?
    @State private var busy = false
    @State private var handled: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if permission == .authorized {
                QRCameraView { data in Task { await onScan(data) } }
                    .ignoresSafeArea()
            } else {
                VStack(spacing: 14) {
                    Text("Harness needs the camera to scan the pairing QR code.")
                        .font(.system(size: 17)).foregroundStyle(.white).multilineTextAlignment(.center)
                    if permission == .notDetermined {
                        HButton("Allow camera", variant: .primary, fullWidth: false) {
                            Task {
                                _ = await AVCaptureDevice.requestAccess(for: .video)
                                permission = AVCaptureDevice.authorizationStatus(for: .video)
                            }
                        }
                    } else {
                        HButton("Open Settings to allow", variant: .primary, fullWidth: false) {
                            if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) }
                        }
                    }
                }
                .padding(30)
            }

            RoundedRectangle(cornerRadius: 28)
                .strokeBorder(.white.opacity(0.85), lineWidth: 3)
                .frame(width: 240, height: 240)
                .allowsHitTesting(false)
                .accessibilityHidden(true)

            VStack(spacing: 12) {
                Spacer()
                if busy { ProgressView().tint(.white) }
                Text(message ?? "Point at the QR code in Harness → Settings → Network on your Mac.")
                    .font(.system(size: 15)).foregroundStyle(.white).multilineTextAlignment(.center)
                    .padding(10)
                    .background(.black.opacity(0.55), in: .rect(cornerRadius: 12))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .overlay(alignment: .topTrailing) {
            Button { router.cover = nil } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.5), in: .circle)
            }
            .accessibilityLabel("Close")
            .padding(.top, 10)
            .padding(.trailing, 16)
        }
        .onAppear { permission = AVCaptureDevice.authorizationStatus(for: .video) }
        // Back from Settings (Open Settings to allow): pick up the new answer.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { permission = AVCaptureDevice.authorizationStatus(for: .video) }
        }
    }

    private func onScan(_ data: String) async {
        guard !busy, handled != data else { return }
        handled = data
        let parsed = MobilePair.parsePairLink(data)
        guard case let .ok(address) = parsed else {
            haptic(.warning)
            message = parsed.error
            return
        }
        busy = true
        message = nil
        let r = await app.pair(address)
        busy = false
        if case let .failure(f) = r {
            haptic(.error)
            message = f.message
            handled = nil
            return
        }
        haptic(.success)
        router.showBoard()
    }
}

/// The back camera's preview with a QR-only metadata output. Calls `onCode` on the main actor
/// with each code's string (repeats included; ScanScreen filters).
struct QRCameraView: UIViewRepresentable {
    let onCode: @MainActor (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.videoGravity = .resizeAspectFill
        context.coordinator.start(on: view)
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        context.coordinator.onCode = onCode
    }

    static func dismantleUIView(_ view: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
        var onCode: @MainActor (String) -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "harness.scan")

        init(onCode: @escaping @MainActor (String) -> Void) { self.onCode = onCode }

        @MainActor
        func start(on view: PreviewView) {
            view.previewLayer.session = session
            queue.async { [session] in
                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                      let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
                session.beginConfiguration()
                session.addInput(input)
                let output = AVCaptureMetadataOutput()
                if session.canAddOutput(output) {
                    session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: .main)
                    if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
                }
                session.commitConfiguration()
                session.startRunning()
            }
        }

        func stop() {
            queue.async { [session] in session.stopRunning() }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
            MainActor.assumeIsolated { onCode(code) }
        }
    }
}
