import SwiftUI
import DeployCore

/// The server owns clone paths and the SSH port, just as in the web repository hub.
struct RepositoryCloneView: View {
    let repository: RepositoryInfo
    let connection: Connection
    @State private var ssh = false
    @Environment(\.colorScheme) private var scheme
    private var url: String? { repository.cloneURL(origin: connection.origin, ssh: ssh)?.absoluteString }

    var body: some View {
        VStack(alignment: .leading, spacing: WorkspaceStyle.space3) {
            Text("Clone repository").font(WorkspaceStyle.navigation.weight(.semibold))
            Picker("Clone protocol", selection: $ssh) {
                Text("HTTPS").tag(false)
                Text("SSH").tag(true)
            }.pickerStyle(.segmented)
            HStack(spacing: WorkspaceStyle.space2) {
                TextField(ssh ? "SSH clone URL" : "HTTPS clone URL", text: .constant(url ?? ""))
                    .modifier(WorkspaceInput(focused: false))
                    .accessibilityLabel(ssh ? "SSH clone URL" : "HTTPS clone URL")
                WorkspaceCopyButton(label: "Copy clone command", text: url.map { "git clone \($0)" } ?? "")
                    .disabled(url == nil)
            }
            if ssh {
                Text(url == nil ? "SSH is unavailable on this server." : "Use an SSH key added to your account.")
                    .font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                if let base = try? connection.baseURL(), let settings = URL(string: "/dashboard/settings#settings-ssh-keys", relativeTo: base) {
                    Link("Settings → SSH keys", destination: settings).font(WorkspaceStyle.metadata)
                }
            } else {
                Text("Use your deploy.local username and session token. Keep the token in your Git credential manager.")
                    .font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            }
        }
        .textSelection(.enabled)
        .tint(WorkspaceStyle.accent(scheme))
    }
}
