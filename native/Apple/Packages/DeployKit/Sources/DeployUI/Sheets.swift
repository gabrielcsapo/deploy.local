import SwiftUI
import DeployCore

struct ConnectionSheet: View {
    @Bindable var store: WorkspaceStore
    var isPushed = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var origin = "https://deploy.local"
    @State private var username = ""
    @State private var password = ""
    /// Only this sheet's own sign-in failures; session notices stay in the workspace banner.
    @State private var failure: String?
    @FocusState private var focus: Field?
    private enum Field { case origin, username, password }

    private var canConnect: Bool {
        !store.busy && !origin.trimmingCharacters(in: .whitespaces).isEmpty && !username.isEmpty && !password.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 14) {
                    BrandTile(size: 40)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Connect to home").font(.system(.title2, weight: .semibold))
                            .foregroundStyle(WorkspaceStyle.text(scheme))
                        Text("Sign in to your deploy.local coordinator. Your projects and conversations stay on it.")
                            .font(WorkspaceStyle.body).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }.padding(.bottom, 24)

                VStack(alignment: .leading, spacing: 16) {
                    field("Coordinator", .origin) {
                        TextField("", text: $origin, prompt: Text(verbatim: "https://deploy.local"))
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never).keyboardType(.URL)
                            #endif
                            .submitLabel(.next).onSubmit { focus = .username }
                            .accessibilityIdentifier("coordinator-url")
                    }
                    field("Username", .username) {
                        TextField("", text: $username, prompt: Text("Username"))
                            .textContentType(.username).autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never).keyboardType(.asciiCapable)
                            #endif
                            .submitLabel(.next).onSubmit { focus = .password }
                            .accessibilityIdentifier("login-username")
                    }
                    field("Password", .password) {
                        SecureField("", text: $password, prompt: Text("Password")).textContentType(.password)
                            .submitLabel(.go).onSubmit { if canConnect { connect() } }
                            .accessibilityIdentifier("login-password")
                    }
                }

                if let failure {
                    WorkspaceNotice(message: failure, tone: "failed").padding(.top, 16)
                        .accessibilityIdentifier("login-error")
                }

                HStack(spacing: 10) {
                    if store.connection != nil {
                        Button("Disconnect") { store.disconnect(); dismiss() }.buttonStyle(.workspaceDanger)
                    }
                    Spacer(minLength: 0)
                    if !isPushed {
                        Button("Cancel") { dismiss() }.buttonStyle(.workspaceSecondary).keyboardShortcut(.cancelAction)
                    }
                    Button { connect() } label: {
                        HStack(spacing: 8) {
                            if store.busy { ProgressView().controlSize(.small).tint(WorkspaceStyle.onAction(scheme)) }
                            Text(store.busy ? "Connecting…" : "Connect")
                        }
                    }.buttonStyle(.workspacePrimary).keyboardShortcut(.defaultAction).disabled(!canConnect)
                        .accessibilityIdentifier("login-connect")
                }.padding(.top, 24)

                Divider().overlay(WorkspaceStyle.line(scheme)).padding(.top, 22).padding(.bottom, 14)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "lock").font(.system(.caption, weight: .semibold)).accessibilityHidden(true)
                    Text("Your login is kept in this device’s Keychain. HTTPS uses the system’s certificate trust.")
                        .fixedSize(horizontal: false, vertical: true)
                }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            }.padding(28)
            #if os(macOS)
            .frame(width: 440)
            #endif
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(WorkspaceStyle.surface(scheme))
        .modifier(ConnectionPresentation(isPushed: isPushed))
        .onAppear {
            origin = store.connection?.origin ?? UserDefaults.standard.string(forKey: "deploy.lastOrigin") ?? "https://deploy.local"
            username = store.connection?.username ?? ""
            focus = username.isEmpty ? .username : .password
        }
        .onChange(of: origin) { _, value in UserDefaults.standard.set(value, forKey: "deploy.lastOrigin") }
    }

    private func connect() {
        guard canConnect else { return }
        failure = nil
        let previous = store.connection
        Task {
            await store.login(origin: origin.trimmingCharacters(in: .whitespaces), username: username, password: password)
            // A new connection means sign-in succeeded (a Keychain notice may still follow in the banner).
            if let connection = store.connection, connection != previous {
                password = ""
                dismiss()
            } else {
                failure = store.error ?? "Couldn’t sign in. Check the coordinator address, username and password."
                focus = .password
            }
        }
    }

    private func field<Content: View>(_ title: String, _ id: Field, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(WorkspaceStyle.metadata.weight(.medium)).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            content().focused($focus, equals: id).modifier(WorkspaceInput(focused: focus == id))
        }
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

private struct ConnectionPresentation: ViewModifier {
    var isPushed: Bool
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        #if os(iOS)
        if isPushed { content.navigationTitle("Connection").navigationBarTitleDisplayMode(.inline) }
        else { content.workspaceSheet() }
        #else
        content.workspaceSheet().presentationBackground(WorkspaceStyle.surface(scheme))
        #endif
    }
}
