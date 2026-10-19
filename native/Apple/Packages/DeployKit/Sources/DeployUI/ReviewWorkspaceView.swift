import SwiftUI
import DeployCore

/// Review is a work surface: changes and checks each have a readable, full-height pane.
struct ChangesView: View {
    @Bindable var store: WorkspaceStore
    var section = "Changes"
    @Environment(\.colorScheme) private var scheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var wrapLines = false
    private var isPhone: Bool { horizontalSizeClass == .compact }
    #else
    private var isPhone: Bool { false }
    #endif
    private var patches: [ReviewFilePatch] {
        guard let diff = store.diff else { return [] }
        return reviewFilePatches(diff.patch, files: diff.files)
    }
    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { reader in
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if section == "Checks" { checks }
                        else {
                            HStack {
                                Text(store.diff.map { "\($0.files.count) changed \($0.files.count == 1 ? "file" : "files")" } ?? "Loading changes…")
                                    .font(WorkspaceStyle.navigation.weight(.medium))
                                Spacer()
                                Button { Task { await store.loadDiff() } } label: { WorkspaceGlyph(name: .reset, size: 18) }
                                    .buttonStyle(.plain).accessibilityLabel("Refresh changes")
                            }
                            if let diff = store.diff {
                                if diff.files.isEmpty && diff.patch.isEmpty {
                                    Label("No changes in this task", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                                } else {
                                    VStack(spacing: 2) {
                                        ForEach(diff.files) { file in
                                            Button { reader.scrollTo(file.path, anchor: .top) } label: {
                                                HStack(spacing: 10) {
                                                    WorkspaceGlyph(name: .file, size: 16).foregroundStyle(.secondary)
                                                    Text(file.path).lineLimit(isPhone ? 2 : 1).truncationMode(.middle)
                                                    Spacer(minLength: 8)
                                                    #if os(iOS)
                                                    if horizontalSizeClass == .compact {
                                                        VStack(alignment: .trailing, spacing: 4) {
                                                            Text(file.status.contains("?") || file.status.contains("A") ? "New file" : file.status.contains("D") ? "Deleted" : "Modified")
                                                            let lines = patches.first { $0.path == file.path }?.lines ?? []
                                                            HStack(spacing: 6) {
                                                                Text("+\(lines.filter { $0.kind == .addition }.count)").foregroundStyle(WorkspaceStyle.success(scheme))
                                                                Text("−\(lines.filter { $0.kind == .deletion }.count)").foregroundStyle(WorkspaceStyle.danger(scheme))
                                                            }
                                                        }.font(.caption).fixedSize(horizontal: true, vertical: false)
                                                    } else { fileStatus(file) }
                                                    #else
                                                    fileStatus(file)
                                                    #endif
                                                }.font(WorkspaceStyle.navigation).padding(.vertical, 9).contentShape(Rectangle())
                                            }.buttonStyle(.plain).accessibilityLabel(fileAccessibilityLabel(file))
                                        }
                                    }
                                    #if os(iOS)
                                    if horizontalSizeClass == .compact {
                                        Toggle("Wrap diff lines", isOn: $wrapLines).font(.subheadline)
                                            .accessibilityHint("Wrap long lines to read without horizontal scrolling")
                                    }
                                    #endif
                                    ForEach(patches) { file in
                                        VStack(alignment: .leading, spacing: 12) {
                                            Text(file.path).font(WorkspaceStyle.navigation.weight(.semibold)).textSelection(.enabled)
                                            if file.lines.isEmpty {
                                                Text("No text diff is available for this file.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                                            } else {
                                                #if os(iOS)
                                                FilePatchView(file: file, minimumWidth: max(0, geometry.size.width - 48), wrapLines: horizontalSizeClass == .compact && wrapLines,
                                                              isNewFile: diff.files.contains { $0.path == file.path && ($0.status.contains("?") || $0.status.contains("A")) })
                                                #else
                                                FilePatchView(file: file, minimumWidth: max(0, geometry.size.width - 48))
                                                #endif
                                            }
                                        }.id(file.path)
                                    }
                                }
                            } else if let error = store.error {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme))
                                    Button("Retry") { Task { await store.loadDiff() } }
                                }
                            } else { ProgressView().controlSize(.small) }
                        }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }.accessibilityLabel(section == "Checks" ? "Task checks" : "Task changes")
            }
        }.task(id: store.selectedTaskId) { await store.loadDiff() }
    }
    private func fileAccessibilityLabel(_ file: ChangedFile) -> String {
        let label = "Show diff for \(file.path)"
        guard isPhone else { return label }
        let lines = patches.first { $0.path == file.path }?.lines ?? []
        return label + ", \(lines.filter { $0.kind == .addition }.count) additions, \(lines.filter { $0.kind == .deletion }.count) deletions"
    }
    private func fileStatus(_ file: ChangedFile) -> some View {
        Text(file.status.contains("?") || file.status.contains("A") ? "Added" : file.status.contains("D") ? "Deleted" : "Modified")
            .font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
    }
    private var checks: some View {
        VStack(alignment: .leading, spacing: 20) {
            if store.diff?.checks.isEmpty != false && (store.detail?.jobs?.isEmpty ?? true) {
                Text(store.currentTask?.workerId == nil || store.currentTask?.workerId == "local" ? "Run a command to verify your changes." : "Ask the task to run checks on its computer.")
                    .font(WorkspaceStyle.navigation).foregroundStyle(.secondary)
            }
            ForEach(Array((store.diff?.checks ?? []).reversed().enumerated()), id: \.offset) { _, check in
                ReviewCheckRow(check: check)
            }
            ForEach(store.detail?.jobs ?? []) { job in CheckpointJobRow(job: job) }
            if store.currentTask?.workerId == nil || store.currentTask?.workerId == "local" {
                HStack(spacing: 12) {
                    TextField("Check command", text: $store.checkCommand).textFieldStyle(.plain)
                        .font(.system(.subheadline, design: .monospaced)).accessibilityLabel("Check command")
                    Button { Task { await store.runCheck() } } label: { Image(systemName: "play.fill") }
                        .buttonStyle(.plain).disabled(store.busy || store.isWorking).accessibilityLabel("Run check")
                }.padding(14).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

private struct FilePatchView: View {
    let file: ReviewFilePatch
    let minimumWidth: CGFloat
    var wrapLines = false
    var isNewFile = false
    @Environment(\.colorScheme) private var scheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private var visibleLines: [ReviewPatchLine] {
        #if os(iOS)
        let added = isNewFile || file.lines.contains { $0.kind == .metadata && $0.text.hasPrefix("new file mode ") }
        if horizontalSizeClass == .compact && added { return file.lines.filter { $0.kind != .hunk } }
        #endif
        return file.lines
    }
    private func color(_ kind: ReviewPatchLine.Kind) -> Color {
        kind == .addition ? WorkspaceStyle.success(scheme) : kind == .deletion ? WorkspaceStyle.danger(scheme) : kind == .hunk ? WorkspaceStyle.accent(scheme) : .primary
    }
    var body: some View {
        Group {
            if wrapLines { patchLines.frame(width: minimumWidth, alignment: .leading) }
            else {
                ScrollView(.horizontal) { patchLines }
                    #if os(iOS)
                    .scrollIndicators(.visible)
                    .overlay(alignment: .trailing) {
                        LinearGradient(colors: [.clear, WorkspaceStyle.canvas(scheme)], startPoint: .leading, endPoint: .trailing)
                            .frame(width: 18).allowsHitTesting(false)
                    }
                    #endif
            }
        }.accessibilityLabel("Diff for \(file.path)")
    }
    private var patchLines: some View {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(visibleLines.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        HStack(spacing: 4) {
                            Text(line.oldNumber.map(String.init) ?? "").frame(width: 28, alignment: .trailing)
                            Text(line.newNumber.map(String.init) ?? "").frame(width: 28, alignment: .trailing)
                        }.foregroundStyle(.secondary).accessibilityHidden(true)
                        #if os(iOS)
                        Text(line.kind == .metadata && line.text.hasPrefix("new file mode ") ? "New file" : line.text.isEmpty ? " " : line.text)
                            .foregroundStyle(color(line.kind)).textSelection(.enabled)
                            .fixedSize(horizontal: !wrapLines, vertical: wrapLines)
                            .frame(maxWidth: wrapLines ? .infinity : nil, alignment: .leading)
                        #else
                        Text(line.text.isEmpty ? " " : line.text).foregroundStyle(color(line.kind)).textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                        #endif
                        Spacer(minLength: 12)
                    }.font(.system(.footnote, design: .monospaced)).padding(.vertical, 3).padding(.leading, 8)
                        .frame(minWidth: minimumWidth, alignment: .leading)
                        .background(line.kind == .addition || line.kind == .deletion ? color(line.kind).opacity(0.08) : line.kind == .hunk ? Color.primary.opacity(0.035) : .clear)
                }
            }.frame(minWidth: minimumWidth, alignment: .leading)
    }
}

private struct ReviewCheckRow: View {
    let check: JSONValue
    @Environment(\.colorScheme) private var scheme
    private func value(_ key: String) -> String {
        guard case .object(let object) = check else { return "" }
        return object[key]?.displayText ?? ""
    }
    private var status: String {
        if !value("status").isEmpty { return value("status") }
        guard case .object(let object) = check, case .number(let code) = object["exitCode"] else { return "unknown" }
        return code == 0 ? "succeeded" : "failed"
    }
    var body: some View {
        DisclosureGroup {
            if !value("output").isEmpty {
                ScrollView(.horizontal) { Text(value("output")).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding(12) }
                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            }
            if !value("error").isEmpty { Text(value("error")).font(.caption).foregroundStyle(WorkspaceStyle.danger(scheme)) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: status == "succeeded" ? "checkmark.circle.fill" : status == "failed" ? "xmark.circle" : "clock")
                    .foregroundStyle(status == "succeeded" ? WorkspaceStyle.success(scheme) : status == "failed" ? WorkspaceStyle.danger(scheme) : .secondary)
                VStack(alignment: .leading, spacing: 5) {
                    Text(value("command")).font(.system(.subheadline, design: .monospaced)).lineLimit(2)
                    Text(status == "succeeded" ? "Passed" : status.capitalized).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                }
            }
        }
    }
}
