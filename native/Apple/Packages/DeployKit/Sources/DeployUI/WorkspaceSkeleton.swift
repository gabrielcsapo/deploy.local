import SwiftUI

/// Layout placeholders carry no invented workspace data. Cached refreshes retain their content.
struct WorkspaceSkeleton: View {
    enum Variant { case rows, sidebar, conversation }
    var variant: Variant = .rows
    var label = "Loading"
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shimmer = false
    var body: some View {
        VStack(alignment: .leading, spacing: variant == .conversation ? WorkspaceStyle.space6 : WorkspaceStyle.space2) {
            ForEach(0..<(variant == .conversation ? 3 : 5), id: \.self) { index in
                GeometryReader { geometry in
                    RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius)
                        .fill(WorkspaceStyle.hover(scheme))
                        .overlay {
                            if !reduceMotion {
                                LinearGradient(colors: [.clear, WorkspaceStyle.surface(scheme), .clear], startPoint: .leading, endPoint: .trailing)
                                    .offset(x: shimmer ? geometry.size.width : -geometry.size.width)
                                    .animation(WorkspaceStyle.Motion.shimmer(reduceMotion: reduceMotion), value: shimmer)
                            }
                        }.clipped()
                        .frame(width: variant == .conversation ? geometry.size.width * (index.isMultiple(of: 2) ? 0.55 : 0.8) : geometry.size.width)
                        .frame(maxWidth: .infinity, alignment: variant == .conversation && index.isMultiple(of: 2) ? .trailing : .leading)
                }.frame(height: variant == .sidebar ? WorkspaceStyle.IconAction.standard : variant == .conversation ? (WorkspaceStyle.space8 * 2) : WorkspaceStyle.skeletonRowHeight)
            }
        }.padding(WorkspaceStyle.space4)
            .accessibilityElement(children: .ignore).accessibilityLabel(label)
            .onAppear { shimmer = !reduceMotion }
            .onChange(of: reduceMotion) { _, reduced in shimmer = !reduced }
    }
}
