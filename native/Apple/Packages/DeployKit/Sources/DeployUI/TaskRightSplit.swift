import SwiftUI

/// The same host stays mounted while hidden so Computer can discover a new session.
struct TaskRightSplit<Content: View>: View {
    @Binding var tab: String?
    @Binding var width: Double
    @Binding var expanded: Bool
    let takeover: Bool
    @ViewBuilder let content: () -> Content
    @State private var dragWidth: Double?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 0) {
            if !takeover {
                Rectangle().fill(WorkspaceStyle.line(scheme)).frame(width: WorkspaceStyle.space1).contentShape(Rectangle())
                    .gesture(DragGesture().onChanged { value in
                        if dragWidth == nil { dragWidth = width }
                        width = min(720, max(320, (dragWidth ?? width) - value.translation.width))
                    }.onEnded { _ in dragWidth = nil })
                    .accessibilityLabel("Resize task panel").accessibilityValue("\(Int(width)) points")
                    .accessibilityAdjustableAction { direction in width = min(720, max(320, width + (direction == .increment ? 16 : -16))) }
                    .focusable()
                    .onKeyPress(.leftArrow) { width = min(720, width + 16); return .handled }
                    .onKeyPress(.rightArrow) { width = max(320, width - 16); return .handled }
            }
            VStack(spacing: 0) {
                HStack(spacing: WorkspaceStyle.space2) {
                    Picker("Task panel", selection: Binding(get: { tab ?? "Computer" }, set: { tab = $0 })) {
                        ForEach(["Computer", "Changes", "Activity"], id: \.self) { Text($0).tag($0) }
                    }.pickerStyle(.segmented).labelsHidden()
                    WorkspaceActionCluster {
                        if tab == "Changes" {
                            WorkspaceIconButton(label: expanded ? "Collapse Changes" : "Expand Changes", icon: expanded ? .collapse : .expand, size: .compact) { expanded.toggle() }
                        }
                        WorkspaceIconButton(label: "Close task panel", icon: takeover ? .chevronLeft : .close, size: .compact, shortcut: "Esc") { tab = nil }
                    }
                }.padding(WorkspaceStyle.space2)
                Divider()
                content().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.background(WorkspaceStyle.canvas(scheme))
            .accessibilityElement(children: .contain).accessibilityLabel("Task panel")
            .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: tab)
            .onKeyPress(.escape) { tab = nil; return .handled }
    }
}
