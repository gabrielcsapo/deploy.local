import SwiftUI
import DeployCore

/// Each row owns both its gutter and wrapped source so line numbers stay aligned.
struct RepositorySourceView: View {
    let content: String
    let path: String
    @Environment(\.colorScheme) private var scheme
    #if os(iOS)
    @State private var wrap = true
    #else
    @State private var wrap = false
    #endif
    @State private var lines: [[SourceHighlight.Span]] = []

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(wrap ? "Don’t wrap lines" : "Wrap lines") { wrap.toggle() }.buttonStyle(.workspaceLink)
                    .accessibilityValue(wrap ? "Wrapping on" : "Wrapping off")
                Spacer()
            }.padding(16)
            GeometryReader { geometry in
                ScrollView(wrap ? [.vertical] : [.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines.indices, id: \.self) { index in
                            HStack(alignment: .top, spacing: 12) {
                                Text(String(index + 1)).monospacedDigit()
                                    .foregroundStyle(WorkspaceStyle.tertiary(scheme))
                                    .frame(width: gutter, alignment: .trailing).accessibilityHidden(true)
                                Text(highlight(lines[index])).textSelection(.enabled)
                                    .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
                                    .fixedSize(horizontal: !wrap, vertical: true)
                            }.frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
                        }
                    }.font(.system(.subheadline, design: .monospaced))
                        .padding(16).frame(minWidth: geometry.size.width, alignment: .topLeading)
                }.accessibilityLabel("Source for \(path)")
            }
        }.task(id: content) { lines = SourceHighlight.lines(content, path: path) }
    }
    private var gutter: CGFloat { CGFloat(max(3, String(lines.count).count)) * 10 }
    private func highlight(_ spans: [SourceHighlight.Span]) -> AttributedString {
        var result = AttributedString()
        for span in spans {
            var part = AttributedString(span.text)
            switch span.role {
            case .plain: part.foregroundColor = WorkspaceStyle.text(scheme)
            case .keyword: part.foregroundColor = WorkspaceStyle.accent(scheme)
            case .string: part.foregroundColor = WorkspaceStyle.success(scheme)
            case .comment: part.foregroundColor = WorkspaceStyle.tertiary(scheme)
            case .number: part.foregroundColor = WorkspaceStyle.warning(scheme)
            }
            result += part
        }
        return result.characters.isEmpty ? AttributedString(" ") : result
    }
}
