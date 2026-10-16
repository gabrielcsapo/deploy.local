import SwiftUI
import DeployCore

struct ConnectionSheet: View {
    @Bindable var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var origin = "https://deploy.local"
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Label("Connect to home", systemImage: "network").font(.title2.weight(.semibold))
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text("Your projects and conversations stay with your home coordinator.").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 14) {
                field("Coordinator") {
                    TextField("https://deploy.local", text: $origin)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.URL)
                        #endif
                        .accessibilityIdentifier("coordinator-url")
                }
                field("Username") {
                    TextField("Username", text: $username)
                        .textContentType(.username).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.asciiCapable)
                        #endif
                        .accessibilityIdentifier("login-username")
                }
                field("Password") {
                    SecureField("Password", text: $password).textContentType(.password)
                        .accessibilityIdentifier("login-password")
                }
            }.textFieldStyle(.roundedBorder)
            if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                if store.connection != nil {
                    Button("Disconnect") { store.disconnect(); dismiss() }.foregroundStyle(.secondary)
                }
                Spacer()
                if store.busy { ProgressView().controlSize(.small) }
                Button("Connect") {
                    Task {
                        await store.login(origin: origin, username: username, password: password)
                        if store.isConnected { password = ""; dismiss() }
                    }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(store.busy || username.isEmpty || password.isEmpty)
            }
            Text("Credentials are stored in this device’s Keychain. HTTPS uses system certificate trust.")
                .font(.caption).foregroundStyle(.secondary)
        }.padding(28).frame(idealWidth: 460)
        }.workspaceSheet()
            .onAppear {
                origin = store.connection?.origin ?? UserDefaults.standard.string(forKey: "deploy.lastOrigin") ?? "https://deploy.local"
                username = store.connection?.username ?? ""
            }
            .onChange(of: origin) { _, value in UserDefaults.standard.set(value, forKey: "deploy.lastOrigin") }
    }

    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption.weight(.medium)); content() }
    }
}

struct ProjectSheet: View {
    @Bindable var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var source = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Add a repository").font(.title2.weight(.semibold))
            Text("Create a home for your project, or import its committed Git history.").foregroundStyle(.secondary)
            TextField("Project name", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("project-name")
            TextField("Git URL or path on the coordinator (optional)", text: $source).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("project-source")
            Text("Leave the source empty for a new hosted repository. Existing working files are preserved.").font(.caption).foregroundStyle(.secondary)
            if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange) }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Create repository") {
                    Task { if await store.createProject(name: name, source: source) { dismiss() } }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy)
            }
        }.padding(28).frame(idealWidth: 480).workspaceSheet()
    }
}

extension View {
    @ViewBuilder func workspaceSheet() -> some View {
        #if os(iOS)
        self.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        #else
        self
        #endif
    }
}
