import Foundation
import Observation
import DeployCore

/// The cache belongs to this signed-in store, never to a process-wide singleton.
/// It remembers successful empty reads as well as rows when a sheet is reopened.
@Observable @MainActor final class V2Read<Value: Sendable> {
    private(set) var value: Value?
    private(set) var state = V2LoadState()
    private var key: String?
    private var active: UUID?

    func load(store: V2Store, key: String, foreground: Bool = true, initial: Value? = nil,
              read: () async throws -> Value) async {
        if self.key != key {
            self.key = key
            value = store.readCache[key] as? Value ?? initial
            state = V2LoadState(hasData: value != nil)
            active = nil
        }
        if let active { if foreground { state.promote(active) }; return }
        let ticket = state.begin(foreground: foreground)
        active = ticket
        defer { if active == ticket { active = nil } }
        do {
            let next = try await read()
            guard !Task.isCancelled, self.key == key, state.succeed(ticket) else { return }
            value = next; store.readCache[key] = next; store.readDates[key] = Date()
        } catch {
            guard !Task.isCancelled, self.key == key else { return }
            state.fail(ticket)
        }
        if active == ticket { active = nil }
    }
    func leave() { state.leave(); active = nil }
}

#if os(iOS)
import SwiftUI
import UIKit

struct V2Skeleton: View {
    var width: CGFloat? = nil
    var height: CGFloat = 14
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        RoundedRectangle(cornerRadius: height > 20 ? 8 : 4)
            .fill(WorkspaceStyle.line(scheme)).frame(width: width, height: height)
            .accessibilityHidden(true)
    }
}
struct V2SkeletonRows: View {
    var count = 3
    var icons = true
    var status = false
    var body: some View {
        V2Group {
            ForEach(0..<count, id: \.self) { index in
                if index > 0 { Divider().padding(.leading, icons ? 58 : 16) }
                HStack(spacing: 12) {
                    if icons { V2Skeleton(width: 30, height: 30) }
                    GeometryReader { proxy in
                        VStack(alignment: .leading, spacing: 8) {
                            V2Skeleton(width: proxy.size.width * [0.62, 0.48, 0.70][index % 3])
                            V2Skeleton(width: proxy.size.width * 0.82, height: 9)
                        }.frame(height: 64)
                    }.frame(height: 64)
                    if status { V2Skeleton(width: 64, height: 10) }
                }.padding(.horizontal, 16).frame(minHeight: 64)
            }
        }.accessibilityHidden(true)
    }
}
struct V2GroupedSkeleton: View {
    var projects = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if projects {
                Text("Active projects grow. Maintained projects get fixes and updates. Done projects rest.")
                    .font(.system(size: 17)).lineSpacing(5)
            }
            ForEach([3, 2], id: \.self) { count in
                V2Skeleton(width: count == 3 ? 118 : 96, height: 12).padding(.horizontal, 16)
                V2SkeletonRows(count: count, icons: !projects, status: !projects)
            }
        }.accessibilityHidden(true)
    }
}
struct V2ConversationSkeleton: View {
    var body: some View {
        GeometryReader { proxy in
            VStack(alignment: .leading, spacing: 32) {
                ForEach([0.78, 1, 0.90], id: \.self) { fraction in
                    VStack(alignment: .leading, spacing: 12) {
                        V2Skeleton(width: proxy.size.width * fraction)
                        V2Skeleton(width: proxy.size.width * 0.92)
                        V2Skeleton(width: proxy.size.width * 0.56)
                    }.padding(.vertical, 16)
                }
            }
        }.frame(height: 318).accessibilityHidden(true)
    }
}

struct V2LoadingCopy {
    let slow: String
    let saved: String
    var work = false
    static let work = Self(slow: "Work is taking longer than usual to load from SER.", saved: "work", work: true)
    static let projects = Self(slow: "Projects are taking longer than usual to load from SER.", saved: "projects")
    static let conversation = Self(slow: "This conversation is taking longer than usual to load from SER.", saved: "conversation")
    static let live = Self(slow: "App status is taking longer than usual to load from SER.", saved: "app status")
    static func resource(_ name: String, plural: Bool = true) -> Self {
        let saved = name == "Project details" ? "projects" : name == "App details" ? "app status" : name.lowercased()
        return Self(slow: "\(name) \(plural ? "are" : "is") taking longer than usual to load from SER.", saved: saved)
    }
}
struct V2LoadingBanner: View {
    let title: String
    let subtitle: String
    var cloud = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if cloud { Image(systemName: "cloud").font(.system(size: 16)).accessibilityHidden(true) }
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 17))
                Text(subtitle).font(.system(size: 13))
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.padding(12).background(WorkspaceStyle.warning(scheme).opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.warning(scheme).opacity(0.25)))
    }
}
/// Same offline banner and last-known treatment at every cached destination.
struct V2LoadNotice: View {
    let state: V2LoadState
    let copy: V2LoadingCopy
    var lastHeard: Date? = nil
    let retry: () async -> Void
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            Group {
                if state.failed {
                    VStack(alignment: .leading, spacing: 12) {
                        V2LoadingBanner(title: "Can't reach SER", subtitle: state.hasData
                            ? lastHeard.map { "Last heard from at \($0.formatted(date: .omitted, time: .shortened)). Retrying." } ?? "Retrying."
                            : "Retrying. No saved \(copy.saved) on this iPhone.", cloud: state.hasData)
                        if !state.hasData {
                            Text("Check that this iPhone is on the same network as SER.").font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 16)
                            Button("Try now") { Task { await retry() } }.buttonStyle(V2SecondaryButtonStyle())
                        }
                    }
                } else if state.isSlow() {
                    V2LoadingBanner(title: copy.slow, subtitle: copy.work ? "Still trying. Your work will appear here when it arrives." : "Still trying.")
                }
            }.modifier(V2StatusAnnouncement(message: state.failed ? "Can't reach SER" : state.isSlow() ? copy.slow : nil))
        }
        .task(id: state.failed) {
            guard state.failed else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await retry()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { await retry() }
        }
    }
}
/// A region owns only its requested resource; neighbouring regions remain readable.
struct V2LoadRegion<Content: View>: View {
    let state: V2LoadState
    let copy: V2LoadingCopy
    var lastHeard: Date? = nil
    var rows = 3
    var icons = true
    var status = false
    var conversation = false
    var skeleton: AnyView? = nil
    let retry: () async -> Void
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            V2LoadNotice(state: state, copy: copy, lastHeard: lastHeard, retry: retry)
            if state.showsSkeleton {
                if let skeleton { skeleton }
                else if conversation { V2ConversationSkeleton() }
                else { V2SkeletonRows(count: rows, icons: icons, status: status) }
            } else if state.hasData {
                if state.failed { Text(copy.saved.prefix(1).uppercased() + copy.saved.dropFirst() + " · last known").font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 12) }
                content.opacity(state.failed ? 0.55 : 1)
            }
        }
    }
}
struct V2LoadingHeader: View {
    var states: [V2LoadState]
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let lines = states.compactMap { $0.header() }
            let text = lines.first(where: { $0 == "Waiting for SER…" }) ?? lines.first(where: { $0 == "Updating…" }) ?? lines.first
            Text(text ?? "").font(.system(size: 13)).foregroundStyle(.secondary)
                .modifier(V2StatusAnnouncement(message: text == "Waiting for SER…" ? nil : text))
        }
    }
}
@MainActor private enum V2StatusVoice {
    private static var last: String?
    static func announce(_ message: String) {
        guard last != message else { return }
        last = message
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}
private struct V2StatusAnnouncement: ViewModifier {
    let message: String?
    @State private var announced: String?
    func body(content: Content) -> some View {
        content.onChange(of: message, initial: true) { _, next in
            guard let next, next != announced else { return }
            announced = next
            V2StatusVoice.announce(next)
        }
    }
}
private struct V2SecondaryButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 15, weight: .medium)).padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 44)
            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
    }
}
extension View {
    func loadingHeader(title: String? = nil, _ states: V2LoadState...) -> some View {
        toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 3) {
                    if let title { Text(title).font(.system(size: 17, weight: .semibold)).lineLimit(1) }
                    V2LoadingHeader(states: states)
                }
            }
        }
    }
}
#endif
