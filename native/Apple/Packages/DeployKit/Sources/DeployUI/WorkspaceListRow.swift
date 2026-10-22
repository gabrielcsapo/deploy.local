import SwiftUI

/// A section's navigation row. Main-area lists may supply secondary text for the resource density.
struct WorkspaceListRow: View {
    let icon: WorkspaceGlyphName
    let title: String
    var secondary: String? = nil
    var selected = false
    let select: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        Button(action: select) {
            HStack(spacing: WorkspaceStyle.space2) {
                WorkspaceGlyph(name: icon)
                VStack(alignment: .leading) {
                    Text(title).font(WorkspaceStyle.navigation).lineLimit(1)
                    if let secondary { Text(secondary).font(WorkspaceStyle.metadata).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer(minLength: 0)
            }.padding(.horizontal, WorkspaceStyle.space2)
                .frame(maxWidth: .infinity, minHeight: secondary == nil ? WorkspaceStyle.taskNavigationHeight : WorkspaceStyle.resourceRowHeight, alignment: .leading)
                .background(selected ? WorkspaceStyle.selected(colorScheme) : .clear, in: RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? [.isSelected] : []).help(title)
    }
}
