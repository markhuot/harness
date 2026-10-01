import HarnessKit
import SwiftUI
import UIKit

/// "iPhone" / "iPad" (lib/device.ts DEVICE), for copy that names the device.
@MainActor var deviceName: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

/// Pairing (screens/Connect.tsx): scan the desktop's QR code (or let the Camera app open
/// harness://pair…), or enter the URL and token by hand. Saved Macs can be switched between.
/// The root screen without an active server, and the Connect sheet (harness://connect) with one.
struct ConnectScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    @State private var url = ""
    @State private var token = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var field: Field?

    private enum Field { case url, token }

    var body: some View {
        Form {
            Section {
                VStack(spacing: 10) {
                    Icon("layers", size: 30, weight: .regular)
                        .foregroundStyle(c.accent)
                        .frame(width: 64, height: 64)
                        .background(c.accentSoft, in: .rect(cornerRadius: 16))
                    Text("Pair with Harness on your Mac")
                        .font(.system(size: 22, weight: .bold)).foregroundStyle(c.text).multilineTextAlignment(.center)
                    Text("On the Mac, open Harness → Settings → Network, choose Tailscale or All networks, and scan the QR code.")
                        .font(.system(size: 15)).foregroundStyle(c.text2).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 12, trailing: 0))
                .listRowSeparator(.hidden)

                if let authError = app.store?.authError {
                    Callout(tone: .red, icon: "key", title: "Token rejected", message: authError)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 12, trailing: 0))
                        .listRowSeparator(.hidden)
                }
                HButton("Scan QR code", icon: "eye", variant: .primary) { router.present(.scan) }
                    .listRowBackground(Color.clear)
                    // Inside the section's rounded clip, so the button's own corners show.
                    .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 8, trailing: 0))
                    .listRowSeparator(.hidden)
            }

            if !app.servers.isEmpty {
                Section("Saved Macs") {
                    ForEach(app.servers) { s in
                        Button {
                            app.activate(s.id)
                            done()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.name).foregroundStyle(c.text)
                                    Text(MobilePair.displayHost(s.baseUrl)).font(.mono(12.5)).foregroundStyle(c.text3)
                                }
                                Spacer()
                                if app.active?.id == s.id {
                                    Icon("check", size: 16, weight: .bold).foregroundStyle(c.accent)
                                }
                            }
                        }
                        .accessibilityAddTraits(app.active?.id == s.id ? .isSelected : [])
                        .listRowBackground(c.bgElev)
                    }
                }
            }

            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Service URL").font(.system(size: 13, weight: .semibold)).foregroundStyle(c.text2)
                    TextField("http://100.64.0.2:7717", text: $url)
                        .font(.mono(15))
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($field, equals: .url)
                        .onSubmit { field = .token }
                        .accessibilityLabel("Service URL")
                }
                .listRowBackground(c.bgElev)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Token").font(.system(size: 13, weight: .semibold)).foregroundStyle(c.text2)
                    SecureField("From Settings → Network → Show token", text: $token)
                        .font(.mono(14))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($field, equals: .token)
                        .onSubmit { Task { await connect() } }
                        .accessibilityLabel("Token")
                }
                .listRowBackground(c.bgElev)
            } header: {
                Text("Enter manually")
            } footer: {
                Text("The token is stored in the \(deviceName)'s Keychain.")
            }

            Section {
                if let error {
                    Callout(tone: .red, icon: "wifiOff", message: error)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 12, trailing: 0))
                        .listRowSeparator(.hidden)
                }
                HButton("Connect", loading: busy, haptic: nil) { Task { await connect() } }
                    .disabled(url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .listRowBackground(Color.clear)
                    // Inside the section's rounded clip, so the button's own corners show.
                    .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 8, trailing: 0))
            }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Connect to a Mac")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func connect() async {
        error = nil
        let base = MobilePair.normalizeBaseUrl(url)
        guard case let .ok(baseUrl) = base else { error = base.error; return }
        let tok = MobilePair.checkToken(token)
        guard case let .ok(t) = tok else { error = tok.error; return }
        busy = true
        let r = await app.pair(ServerAddress(baseUrl: baseUrl, token: t))
        busy = false
        if case let .failure(f) = r {
            haptic(.error)
            error = f.message
            return
        }
        done()
    }

    private func done() {
        haptic(.success)
        router.showBoard()
    }
}

/// harness://pair?url=…&token=… (from the Camera app or a link): waits for the Keychain to load
/// (pairing a Mac that's already saved reuses its entry), then pairs.
struct PairScreen: View {
    let url: String?
    let token: String?

    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    @State private var busy = true
    @State private var error: String?
    @State private var host = ""
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 16) {
            if busy {
                VStack(spacing: 12) {
                    Spinner(large: true)
                    Text("Connecting to \(host.isEmpty ? "your Mac" : host)…").font(.system(size: 16)).foregroundStyle(c.text2)
                }
            } else {
                Callout(tone: .red, icon: "wifiOff", title: "Couldn't pair", message: error ?? "")
                HButton("Try again", variant: .primary) { attempt += 1 }
                Button("Enter the details manually") { router.present(.connect) }
                    .font(.system(size: 15))
                    .foregroundStyle(c.accent)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
        .navigationTitle("Pairing")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: PairTaskID(loaded: app.loaded, url: url, token: token, attempt: attempt)) {
            guard app.loaded else { return }
            await run()
        }
    }

    private struct PairTaskID: Equatable {
        var loaded: Bool
        var url: String?
        var token: String?
        var attempt: Int
    }

    private func run() async {
        let parsed = MobilePair.pairParams(url: url, token: token)
        guard case let .ok(address) = parsed else {
            busy = false
            error = parsed.error
            host = ""
            return
        }
        busy = true
        error = nil
        host = MobilePair.displayHost(address.baseUrl)
        let r = await app.pair(address)
        if case let .failure(f) = r {
            haptic(.error)
            busy = false
            error = f.message
            return
        }
        haptic(.success)
        router.showBoard()
    }
}
