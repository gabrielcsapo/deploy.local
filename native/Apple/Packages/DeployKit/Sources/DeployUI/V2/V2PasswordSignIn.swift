#if os(iOS)
import SwiftUI
import DeployCore

struct V2PasswordSignIn: View {
    let connected: (Connection) -> Void
    @State private var origin = "https://deploy.local"
    @State private var username = ""
    @State private var password = ""
    @State private var candidate: V2CheckedCertificate?
    @State private var busy = false
    @State private var failure: String?
    @State private var operation: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var canSignIn: Bool { !busy && !username.isEmpty && !password.isEmpty && !origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if candidate == nil {
                    Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 22)).frame(width: 44, height: 44) }
                        .accessibilityLabel("Back to sign in").disabled(busy)
                }
                Spacer()
            }.frame(height: 44).padding(.horizontal, 8).padding(.top, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(candidate == nil ? "Sign in with a password" : "Trust SER's certificate?")
                        .font(.system(size: 22, weight: .semibold)).tracking(-0.44)
                        .padding(.horizontal, 32).padding(.top, 12).accessibilityAddTraits(.isHeader)
                    if let candidate {
                        (Text("SER signs its own certificate. Check that these characters match the ones on SER's screen, or run ") + Text("deploy status --fingerprint").font(.system(size: 13, design: .monospaced)) + Text(" on SER."))
                            .font(.system(size: 17)).lineSpacing(3).foregroundStyle(WorkspaceStyle.secondary(scheme))
                            .padding(.horizontal, 32).padding(.top, 16)
                        V2SettingsGroup(title: "SER's certificate") {
                            Text(V2CertificateFingerprint.short(candidate.fingerprint)).font(.system(size: 13, design: .monospaced))
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 16)
                        }.padding(.horizontal, 16)
                        note("Your password has not been sent. It is sent only after you choose They match.").padding(.horizontal, 16).padding(.top, 12)
                    } else {
                        V2SettingsGroup(title: "Server") {
                            field("Address") { TextField("", text: $origin).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled() }
                        }.padding(.horizontal, 16)
                        V2SettingsGroup(title: "Account") {
                            field("Username") { TextField("", text: $username).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled() }
                            Divider()
                            field("Password") { SecureField("", text: $password).textContentType(.password).submitLabel(.go).onSubmit { if canSignIn { signIn() } } }
                        }.padding(.horizontal, 16)
                    }
                    if let failure { note(failure).padding(.horizontal, 16).padding(.top, 16).accessibilityIdentifier("login-error") }
                }.padding(.bottom, 20).disabled(busy)
            }
            VStack(spacing: 12) {
                if let candidate {
                    Button("They match") { signIn(accepting: candidate) }.buttonStyle(V2ActionStyle(primary: true)).disabled(busy)
                    Button("Cancel") { self.candidate = nil; failure = nil }.buttonStyle(V2ActionStyle()).disabled(busy)
                    note("Trusted in this app for \(candidate.origin.replacingOccurrences(of: "https://", with: "")) only. Your iPhone's other apps are not affected.")
                } else {
                    Button("Sign in") { signIn() }.buttonStyle(V2ActionStyle(primary: true)).disabled(!canSignIn)
                    note("The app checks SER's certificate itself. Your login stays in this iPhone's Keychain.")
                }
            }.padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 16)
        }.foregroundStyle(WorkspaceStyle.text(scheme)).background(WorkspaceStyle.canvas(scheme))
            .presentationDetents([.large]).presentationDragIndicator(.visible).interactiveDismissDisabled(busy)
            .onDisappear { operation?.cancel(); password = "" }
    }
    private func note(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).lineSpacing(2).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
    }
    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).frame(minHeight: 24)
            content().frame(minHeight: 44).accessibilityLabel(title)
        }.font(.system(size: 17)).padding(.horizontal, 16).padding(.vertical, 8)
    }
    private func signIn(accepting certificate: V2CheckedCertificate? = nil) {
        guard canSignIn else { return }
        busy = true; failure = nil
        operation = Task {
            defer { busy = false }
            do {
                let address = try V2CertificateVault.origin(origin)
                if let certificate {
                    guard certificate.origin == address else { throw ClientError.invalidOrigin }
                    try Task.checkCancellation()
                    try V2PasswordTrust.accept(certificate)
                    candidate = nil
                } else if let check = try await V2PasswordTrust.prepare(origin: address) {
                    try Task.checkCancellation()
                    candidate = check; return
                }
                try Task.checkCancellation()
                let connection = try await WorkspaceClient.login(origin: address, username: username, password: password)
                try Task.checkCancellation()
                try CredentialVault.save(connection)
                V2PairingVault.clear()
                password = ""; connected(connection); dismiss()
            } catch is CancellationError { }
            catch ClientError.response(401, let message) { failure = message }
            catch { failure = coordinatorErrorDescription(error) }
        }
    }
}
#endif
