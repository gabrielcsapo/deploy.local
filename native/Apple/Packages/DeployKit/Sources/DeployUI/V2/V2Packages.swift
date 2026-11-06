#if os(iOS)
import SwiftUI
import DeployCore

struct V2PackagesView: View {
    let store: V2Store
    @State private var packages: [V2Package] = []
    @State private var copies: V2PackageCopies?
    @State private var selected: V2Package?
    @State private var error: String?
    @State private var loading = true
    @Environment(\.colorScheme) private var scheme
    private var coordinator: String {
        store.snapshot.live?.computers.first(where: { $0.roles.contains(.coordinator) })?.name ?? "your coordinator"
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if loading { ProgressView().frame(maxWidth: .infinity).padding() }
                V2SettingsGroup(list: true, title: "Private", note: "Only people signed in to deploy.local and its computers can install these.") {
                    ForEach(packages) { package in
                        Button { selected = package } label: {
                            V2SettingsRow(list: true, title: package.name, subtitle: "npm" + (package.project.map { " · from \($0)" } ?? ""), icon: "shippingbox") {
                                Text(package.latest?.version ?? "").font(.system(size: 13, design: .monospaced)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                                V2SettingsChevron()
                            }
                        }
                        if package.id != packages.last?.id { Divider() }
                    }
                }
                if let copies {
                    V2SettingsGroup(list: true, title: "Copies", note: "deploy.local keeps a copy of everything your projects install, so installs keep working when these sites are down.") {
                        ForEach(copies.sources) { source in
                            V2SettingsRow(list: true, title: source.name, subtitle: sourceStatus(source), icon: "cloud") { EmptyView() }
                            Divider()
                        }
                        V2SettingsRow(list: true, title: "Kept on \(coordinator)", subtitle: "\(copies.keptDescription) · \(ByteCountFormatter.string(fromByteCount: Int64(copies.storage.bytes), countStyle: .decimal))", icon: "externaldrive") { EmptyView() }
                    }
                }
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding() }
            }.padding(.horizontal, 16).padding(.bottom, 24)
        }.background(WorkspaceStyle.canvas(scheme)).buttonStyle(.plain)
            .navigationTitle("Packages").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .sheet(item: $selected) { package in V2PackageVersionsView(store: store, package: package) }
    }
    private func sourceStatus(_ source: V2PackageCopies.Source) -> String {
        guard source.reachable else { return "Unreachable · Using copies" }
        guard let checked = source.checkedAt, let date = ISO8601DateFormatter().date(from: checked) ?? ISO8601DateFormatter.withFractionalSeconds.date(from: checked) else { return "Reachable" }
        return "Reachable · checked \(max(1, Int(Date().timeIntervalSince(date) / 60))) min ago"
    }
    private func load() async {
        do {
            async let list = store.client.packages()
            async let status = store.client.packageCopies()
            (packages, copies) = try await (list, status)
            error = nil
        } catch { self.error = coordinatorErrorDescription(error) }
        loading = false
    }
}
private extension ISO8601DateFormatter {
    static var withFractionalSeconds: ISO8601DateFormatter {
        let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value
    }
}
struct V2PackageVersionsView: View {
    let store: V2Store
    let package: V2Package
    @State private var versions: [V2PackageVersion] = []
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                V2Group(title: "Versions") {
                    ForEach(versions) { version in
                        V2Row(title: version.version, subtitle: "\(version.attribution) · \(V2Labels.shortDate(version.createdAt))" + (version.deprecated.map { " · \($0)" } ?? ""), icon: "shippingbox")
                        if version.id != versions.last?.id { Divider() }
                    }
                    if let error { Text(error).font(.caption).padding() }
                }.padding(16)
            }.navigationTitle(package.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
                .task { await load() }.refreshable { await load() }
        }
    }
    private func load() async {
        do { versions = try await store.client.packageVersions(package); error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}
#endif
