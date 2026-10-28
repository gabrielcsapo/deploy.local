#if os(iOS)
import SwiftUI
import DeployCore

struct V2BackupsView: View {
    @Bindable var store: V2Store
    @State private var listing: V2Backups?
    @State private var project: String?
    @State private var error: String?
    private var groups: [String] { Array(Set(listing?.backups.compactMap(\.projectId) ?? [])).sorted() }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let listing {
                    V2Group {
                        V2Row(title: "Last backup", subtitle: listing.backups.map(\.createdAt).max().map { V2Labels.shortDate($0) } ?? "Unavailable", icon: "arrow.down.to.line")
                        V2Row(title: "Restore test", subtitle: listing.backups.filter { $0.testedAt != nil }.sorted { ($0.testedAt ?? "") > ($1.testedAt ?? "") }.first.map { "\(V2Labels.shortDate($0.testedAt!)) · \($0.testStatus)" } ?? "Not tested", icon: "checkmark.circle")
                    }
                    V2Group(title: "Projects") {
                        ForEach(groups, id: \.self) { id in
                            let backup = listing.backups.first { $0.projectId == id }
                            Button { project = id } label: { V2Row(title: store.snapshot.projects.first { $0.id == id }?.name ?? id, subtitle: [backup?.contents.joined(separator: ", "), backup?.sizeBytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .decimal) }].compactMap { $0 }.joined(separator: " · "), icon: "externaldrive") }
                        }
                    }
                    if groups.isEmpty { V2Empty(title: "No project backups", message: "Backups appear here after they are recorded on your coordinator.") }
                }
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
            }.padding(16)
        }.navigationTitle("Backups").navigationBarTitleDisplayMode(.inline)
            .task { await load(); if V2Evidence.board == "RestorePhone" { project = "home-gym" } }
            .refreshable { await load() }
            .sheet(isPresented: Binding(get: { project != nil }, set: { if !$0 { project = nil } })) {
                if let project { V2RestoreSheet(store: store, project: project) }
            }
    }
    private func load() async {
        do { listing = try await store.client.backups(); error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}
struct V2RestoreSheet: View {
    @Bindable var store: V2Store
    let project: String
    @State private var backups: [V2Backup] = []
    @State private var selected: String?
    @State private var restore: V2Restore?
    @State private var checked = false
    @State private var ignoredRestores: Set<String> = []
    @State private var confirmSwitch = false
    @State private var busy = false
    @State private var uncertain = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let restore { progress(restore) }
                    else {
                        Text("Restore to a copy first. Your Live data keeps running while you check it.").font(.system(size: 15)).foregroundStyle(.secondary)
                        V2Group {
                            ForEach(backups) { backup in
                                Button { selected = backup.id } label: {
                                    V2Row(title: V2Labels.shortDate(backup.createdAt), subtitle: backup.restoreAvailable ? (backup.releaseId.map { "Before release \($0.prefix(7))" } ?? backup.kind.capitalized) : backup.unavailableReason ?? "Unavailable", icon: selected == backup.id ? "largecircle.fill.circle" : "circle")
                                }.disabled(!backup.restoreAvailable || busy)
                            }
                        }
                        Button(busy ? "Creating copy…" : "Restore to a copy") { perform { restore = try await store.client.restore(backup: selected!) } }
                            .buttonStyle(V2ActionStyle(primary: true)).disabled(selected == nil || busy || !store.online || uncertain)
                        if uncertain { Text("The request may still be running. Refresh to find the copy before trying again.").font(.system(size: 13)) }
                    }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
                    Button("Refresh") { Task { await load() } }.frame(minHeight: 44).disabled(busy)
                }.padding(16)
            }.navigationTitle("Restore \(store.snapshot.projects.first { $0.id == project }?.name ?? project)").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
                .task { await load() }
                .onChange(of: store.snapshot.cursor) { _, _ in if !busy { Task { await load() } } }
                .confirmationDialog("Switch every app to the checked copy? Current Live data is backed up first.", isPresented: $confirmSwitch, titleVisibility: .visible) {
                    Button("I checked it · Switch") { if let restore { perform { self.restore = try await store.client.switchRestore(restore, checked: checked) } } }
                    Button("Cancel", role: .cancel) {}
                }
        }.presentationDetents([.large]).presentationDragIndicator(.visible).interactiveDismissDisabled(busy)
    }
    @ViewBuilder private func progress(_ restore: V2Restore) -> some View {
        V2Row(title: restore.state == "ready" ? "Copy ready to check" : restore.state.capitalized, subtitle: restore.error, icon: "externaldrive")
        if ["cancelled", "live"].contains(restore.state) { Button("Choose another backup") { ignoredRestores.insert(restore.id); self.restore = nil; uncertain = false }.frame(minHeight: 44) }
        if restore.state == "ready" {
            ForEach(restore.addresses, id: \.app) { address in
                if address.isCoordinatorOnly {
                    Text("Check \(address.app) on the coordinator at \(address.url). This address cannot open on your iPhone.").font(.system(size: 15)).textSelection(.enabled)
                } else if let url = URL(string: address.url), ["https", "http"].contains(url.scheme) {
                    Link("Open \(address.app) copy", destination: url).frame(minHeight: 44)
                }
            }
            Toggle("I checked the copy", isOn: $checked).font(.system(size: 17))
            Button("Switch to this copy…") { confirmSwitch = true }.buttonStyle(V2ActionStyle(primary: true)).disabled(!checked || busy || !store.online || uncertain)
        }
        if let release = restore.releaseId { NavigationLink("View release") { V2ReleaseDetail(store: store, releaseId: release) }.frame(minHeight: 44) }
        if let backup = restore.retainedBackupId { Text("Previous Live data retained in backup \(backup). To undo, review the previous release on a computer.").font(.system(size: 13)).textSelection(.enabled) }
        if restore.canCancel { Button("Cancel copy", role: .destructive) { perform { self.restore = try await store.client.cancelRestore(restore) } }.frame(minHeight: 44).disabled(busy || !store.online || uncertain) }
    }
    private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await work(); checked = false; uncertain = false }
            catch { self.error = coordinatorErrorDescription(error); uncertain = true; await load() }
        }
    }
    private func load() async {
        do {
            let listing = try await store.client.backups()
            backups = listing.backups.filter { $0.projectId == project }.sorted { $0.createdAt > $1.createdAt }
            if selected == nil { selected = backups.first { $0.restoreAvailable }?.id }
            let next = listing.restores.filter { $0.projectId == project && !ignoredRestores.contains($0.id) }.sorted { $0.createdAt > $1.createdAt }.first
            if next?.id != restore?.id || next?.state != restore?.state { checked = false }
            restore = next
            if next != nil { uncertain = false }
        } catch { self.error = coordinatorErrorDescription(error) }
    }
}
#endif
