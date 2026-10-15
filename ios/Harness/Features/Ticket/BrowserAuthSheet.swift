import HarnessKit
import SwiftUI

/// The sheet a page's HTTP Basic Auth challenge opens over the Browser tab. The origin leads, the
/// realm is quoted under it, and a refused attempt and an unencrypted `http:` origin each say so.
/// The service keeps what's typed in memory only and never sends it back; every viewer's sheet
/// closes when one answers (BrowserState.auth clears). Cancel is the frame's: it dismisses the sheet, which the Browser tab turns into the cancel input.
struct BrowserAuthSheet: View {
    let auth: BrowserAuth
    let submit: (_ username: String, _ password: String) -> Void

    @Environment(\.palette) private var c
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        TicketDetailSheetFrame(title: "Sign in", subtitle: auth.origin) {
            HButton("Sign in", variant: .primary, fullWidth: false, haptic: nil, action: send)
                .disabled(username.isEmpty)
        } content: {
            if !auth.realm.isEmpty {
                Text("“\(auth.realm)”").font(.scaled(size: 14)).foregroundStyle(c.text2)
            }
            if auth.wasRefused {
                Text("Incorrect username or password.").font(.scaled(size: 14, weight: .medium)).foregroundStyle(c.red)
            }
            field("Username") {
                TextField("", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .username)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
            }
            field("Password") {
                SecureField("", text: $password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(send)
            }
            if auth.isPlainText {
                Text("This site isn't encrypted (http:): the password is sent in the clear.")
                    .font(.scaled(size: 12.5)).foregroundStyle(c.text3)
            }
        }
        .interactiveDismissDisabled()
    }

    private func send() {
        guard !username.isEmpty else { return }
        submit(username, password)
    }

    private func field<F: View>(_ label: String, @ViewBuilder _ input: () -> F) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.scaled(size: 12, weight: .medium)).foregroundStyle(c.text2)
            input()
                .font(.mono(14))
                .foregroundStyle(c.text)
                .padding(.horizontal, 10)
                .frame(minHeight: 36)
                .background(c.bgSunken, in: .rect(cornerRadius: 8))
                .accessibilityLabel(label)
        }
    }
}
