#if os(iOS)
import SwiftUI
import DeployCore

struct V2PackagesView: View {
    let store: V2Store
    @State private var privateRead = V2Read<[V2Package]>()
    private var packages: [V2Package]? { privateRead.value }
    @State private var copiesRead = V2Read<V2PackageCopies>()
    private var copies: V2PackageCopies? { copiesRead.value }
    @State private var selected: V2Package?
    @Environment(\.colorScheme) private var scheme
    private var coordinator: String {
        store.snapshot.live?.computers.first(where: { $0.roles.contains(.coordinator) })?.name ?? "your coordinator"
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    if !privateRead.state.hasData { Text("Private").font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.top, 20) }
                    V2LoadRegion(state: privateRead.state, copy: .resource("Private packages"), lastHeard: store.readDates["packages"], retry: { await loadPrivate() }) { privateSection }
                }
                VStack(alignment: .leading, spacing: 8) {
                    if !copiesRead.state.hasData { Text("Copies").font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.top, 20) }
                    V2LoadRegion(state: copiesRead.state, copy: .resource("Package copies"), lastHeard: store.readDates["copies"], retry: { await loadCopies() }) { copiesSection }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 24)
        }.background(WorkspaceStyle.canvas(scheme)).buttonStyle(.plain)
            .navigationTitle("Packages").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .loadingHeader(title: "Packages", privateRead.state, copiesRead.state)
            .onDisappear { privateRead.leave(); copiesRead.leave() }
            .sheet(item: $selected) { package in V2PackageVersionsView(store: store, package: package) }
    }
    @ViewBuilder private var privateSection: some View {
        if let packages, packages.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Private").font(.system(size: 13)).frame(minHeight: 18)
                    .foregroundStyle(WorkspaceStyle.tertiary(scheme)).accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 4) {
                    Text("No private packages yet").font(.system(size: 15, weight: .semibold)).foregroundStyle(WorkspaceStyle.text(scheme))
                    Text("Publish from a pipeline, or with \(Text("deploy packages publish").font(.system(size: 12, design: .monospaced))) on a computer.")
                        .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                }
            }.padding(.horizontal, 16).padding(.top, 20)
        } else if let packages {
            V2SettingsGroup(list: true, title: "Private", note: "Only people signed in to deploy.local and its computers can install these.") {
                ForEach(packages) { package in
                    Button { selected = package } label: {
                        V2SettingsRow(list: true, title: package.name, monoTitle: true, subtitle: package.subtitle, icon: package.ecosystem == "cargo" ? "briefcase" : "shippingbox") {
                            latestVersion(package.latest?.version ?? "")
                            V2SettingsChevron()
                        }
                    }
                    if package.id != packages.last?.id { Divider() }
                }
            }

        }
    }
    @ViewBuilder private var copiesSection: some View {
        if let copies {
            V2SettingsGroup(list: true, title: "Copies", note: "deploy.local keeps a copy of everything your projects install, so installs keep working when these sites are down.") {
                ForEach(copies.sources) { source in
                    V2SettingsRow(list: true, title: source.name, subtitle: sourceStatus(source), icon: "cloud") { EmptyView() }
                    Divider()
                }
                V2SettingsRow(list: true, title: "Kept on \(coordinator)", subtitle: "\(copies.keptDescription) · \(copies.storage.description)", icon: "cylinder.split.1x2") { EmptyView() }
            }

        }
    }
    /// A long version must not squeeze the name; the versions sheet shows it in full.
    @ViewBuilder private func latestVersion(_ version: String) -> some View {
        let text = Text(version).font(.system(size: 15)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
        if version.count > 12 {
            text.lineLimit(1).truncationMode(.middle).frame(width: 96, alignment: .trailing)
        } else { text.fixedSize() }
    }
    private func sourceStatus(_ source: V2PackageCopies.Source) -> String {
        guard source.reachable else { return "Unreachable · Using copies" }
        guard let checked = source.checkedAt, let date = ISO8601DateFormatter().date(from: checked) ?? ISO8601DateFormatter.withFractionalSeconds.date(from: checked) else { return "Reachable" }
        return "Reachable · checked \(max(1, Int(Date().timeIntervalSince(date) / 60))) min ago"
    }
    /// The two parts load apart, so one failing leaves the other on screen. A part that has
    /// rows keeps them when a later refresh fails.
    private func load() async {
        async let list: Void = loadPrivate()
        async let status: Void = loadCopies()
        _ = await (list, status)
    }
    private func loadPrivate() async {
        await privateRead.load(store: store, key: "packages") { try await store.client.packages() }
        if V2Evidence.board == "PackageVersionsPhone", selected == nil { selected = packages?.first }
    }
    private func loadCopies() async { await copiesRead.load(store: store, key: "copies") { try await store.client.packageCopies() } }

}
private extension ISO8601DateFormatter {
    static var withFractionalSeconds: ISO8601DateFormatter {
        let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value
    }
}
struct V2PackageVersionsView: View {
    let store: V2Store
    let package: V2Package
    @State private var read = V2Read<[V2PackageVersion]>()
    private var versions: [V2PackageVersion] { read.value ?? [] }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    V2LoadRegion(state: read.state, copy: .resource("Package versions"), lastHeard: store.readDates["versions:" + package.id], icons: false, retry: { await load() }) {
                        if !versions.isEmpty {
                            V2SettingsGroup(list: true, title: "Versions") {
                                ForEach(versions) { version in
                                    V2SettingsRow(list: true, title: version.version, monoTitle: true, subtitle: subtitle(version), icon: package.ecosystem == "cargo" ? "briefcase" : "shippingbox") { EmptyView() }
                                    if version.id != versions.last?.id { Divider() }
                                }
                            }
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 24)
            }.background(WorkspaceStyle.canvas(scheme))
                .navigationTitle(package.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
                .task(id: package.id) { await load() }.refreshable { await load() }
                .loadingHeader(title: package.name, read.state).onDisappear { read.leave() }
        }
    }
    private func subtitle(_ version: V2PackageVersion) -> String {
        "\(version.attribution) · \(V2Labels.versionDate(version.createdAt))" + (version.deprecated.map { " · \($0)" } ?? "")
    }
    private func load() async {
        await read.load(store: store, key: "versions:" + package.id) { try await store.client.packageVersions(package) }
    }
}
#endif
