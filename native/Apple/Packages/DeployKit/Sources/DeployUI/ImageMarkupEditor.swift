import DeployCore
import SwiftUI

#if os(iOS)
  import PencilKit
  import UIKit
#else
  import AppKit
#endif

struct MarkupActions {
  var upload: @MainActor (MediaAttachment, Data) async throws -> Void
  var focus: @MainActor (String) -> Void
}
private struct MarkupActionsKey: EnvironmentKey { static let defaultValue: MarkupActions? = nil }
extension EnvironmentValues {
  var markupActions: MarkupActions? {
    get { self[MarkupActionsKey.self] }
    set { self[MarkupActionsKey.self] = newValue }
  }
}
struct ImageMarkupButton: View {
  let attachment: MediaAttachment
  var done: () -> Void = {}
  @Environment(\.markupActions) private var actions
  @State private var open = false
  var body: some View {
    if actions != nil {
      WorkspaceIconButton(label: "Mark up \(attachment.name)", icon: .pen) { open = true }
        .sheet(isPresented: $open) {
          ImageMarkupEditor(attachment: attachment) {
            open = false
            done()
            actions?.focus(attachment.taskId)
          }
        }
    }
  }
}
struct ImageMarkupEditor: View {
  let attachment: MediaAttachment
  var done: () -> Void
  @Environment(\.mediaConnection) private var connection
  @Environment(\.markupActions) private var actions
  @Environment(\.colorScheme) private var scheme
  @Environment(\.dismiss) private var dismiss
  @State private var image: CGImage?
  @State private var history = MarkHistory()
  @State private var tool: MarkTool = .pen
  @State private var color: MarkColor = .accent
  @State private var width = WorkspaceStyle.markupMedium
  @State private var label = ""
  @State private var active: MarkShape?
  @State private var error: String?
  @State private var busy = false
  private func markColor(_ color: MarkColor) -> Color {
    switch color {
    case .accent: WorkspaceStyle.accent(scheme)
    case .attention: WorkspaceStyle.statusAttention(scheme)
    case .failed: WorkspaceStyle.statusFailed(scheme)
    }
  }
  private func cgColor(_ color: MarkColor) -> CGColor {
    #if os(macOS)
      NSColor(markColor(color)).cgColor
    #else
      UIColor(markColor(color)).cgColor
    #endif
  }
  var body: some View {
    VStack(spacing: WorkspaceStyle.space3) {
      // One header: a quiet Cancel, the title, and the single primary action.
      HStack {
        Button("Cancel") { dismiss() }.buttonStyle(.workspaceLink).disabled(busy)
        Spacer()
        Text("Mark up").font(.headline)
        Spacer()
        Button(busy ? "Attaching…" : "Attach") { Task { await attach() } }
          .buttonStyle(.workspacePrimary).disabled(image == nil || busy)
          .accessibilityLabel("Attach to message")
      }
      if tool == .text {
        TextField("Label text", text: $label).textFieldStyle(.roundedBorder).disabled(busy)
      }
      if let error { Text(error).foregroundStyle(WorkspaceStyle.statusFailed(scheme)) }
      if let image {
        GeometryReader { geometry in
          let factor = min(
            geometry.size.width / CGFloat(image.width), geometry.size.height / CGFloat(image.height)
          )
          let size = CGSize(
            width: CGFloat(image.width) * factor, height: CGFloat(image.height) * factor)
          ZStack(alignment: .topLeading) {
            Image(decorative: image, scale: 1).resizable()
            #if os(iOS)
              MarkupPencilSurface(
                data: history.document.pencil,
                nativeSize: CGSize(width: image.width, height: image.height),
                color: UIColor(markColor(color)),
                width: width * min(size.width, size.height) / WorkspaceStyle.mediaViewerHeight,
                enabled: tool == .pen && !busy
              ) { data in
                var document = history.document
                document.pencil = data
                history.change(document)
              }
            #endif
            Canvas { context, canvasSize in
              context.withCGContext { cg in
                MarkupRaster.draw(
                  history.document.shapes + (active.map { [$0] } ?? []), in: cg, size: canvasSize,
                  reference: WorkspaceStyle.mediaViewerHeight,
                  labelSize: WorkspaceStyle.markupLabelSize, color: cgColor)
              }
            }
            .contentShape(Rectangle())
            .gesture(
              DragGesture(minimumDistance: 0).onChanged { value in
                guard shapeInput, !busy,
                  tool != .text || !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { return }
                let point = MarkPoint(
                  x: min(1, max(0, value.location.x / size.width)),
                  y: min(1, max(0, value.location.y / size.height)))
                if active == nil {
                  active = MarkShape(
                    tool: tool,
                    points: [
                      MarkPoint(
                        x: min(1, max(0, value.startLocation.x / size.width)),
                        y: min(1, max(0, value.startLocation.y / size.height)))
                    ], color: color, width: width, text: label)
                }
                if tool == .pen {
                  active?.points.append(point)
                } else if tool != .text, let start = active?.points.first {
                  active?.points = [start, point]
                }
              }.onEnded { _ in
                if let active {
                  var document = history.document
                  document.shapes.append(active)
                  history.change(document)
                }
                active = nil
              }
            )
            .allowsHitTesting(shapeInput && !busy)
          }.frame(width: size.width, height: size.height)
            .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
        }
      } else if error == nil {
        ProgressView("Loading image…").frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      palette.disabled(busy)
    }
    .padding(WorkspaceStyle.space4)
    .frame(minWidth: nil, maxWidth: .infinity, maxHeight: .infinity)
    #if os(macOS)
      .frame(minWidth: WorkspaceStyle.mediaViewerWidth, minHeight: WorkspaceStyle.mediaViewerHeight)
    #endif
    .interactiveDismissDisabled(busy)
    .task {
      guard let connection else {
        error = "Sign in again"
        return
      }
      do {
        image = try MarkupRaster.source(
          await AuthenticatedImageCache.shared.data(
            connection: connection, attachmentId: attachment.id))
      } catch { self.error = error.localizedDescription }
    }
  }
  /// Tools and styles as compact icon controls under the image, within thumb reach.
  private var palette: some View {
    VStack(spacing: WorkspaceStyle.space2) {
      ScrollView(.horizontal) {
        WorkspaceActionCluster {
          ForEach(MarkTool.allCases, id: \.self) { item in
            WorkspaceIconButton(label: toolName(item), icon: toolSymbol(item), pressed: tool == item) { tool = item }
          }
          Divider().frame(height: 24).padding(.horizontal, WorkspaceStyle.space2)
          WorkspaceIconButton(label: "Undo", icon: .undo) { history.undo() }.disabled(history.past.isEmpty)
          WorkspaceIconButton(label: "Redo", icon: .redo) { history.redo() }.disabled(history.future.isEmpty)
          WorkspaceIconButton(label: "Clear all marks", icon: .trash) { history.change(MarkDocument()) }
            .disabled(history.document == MarkDocument())
        }
      }.scrollIndicators(.hidden)
      HStack(spacing: WorkspaceStyle.space3) {
        ForEach(MarkColor.allCases, id: \.self) { item in
          Button { color = item } label: {
            Circle().fill(markColor(item)).frame(width: 22, height: 22)
              .overlay(Circle().strokeBorder(WorkspaceStyle.text(scheme), lineWidth: color == item ? 2 : 0).padding(-4))
              .frame(width: 36, height: 36).contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityLabel("\(item.rawValue.capitalized) colour")
            .accessibilityAddTraits(color == item ? .isSelected : [])
            .accessibilityValue(color == item ? "On" : "Off").help("\(item.rawValue.capitalized) colour")
        }
        Divider().frame(height: 24)
        ForEach([WorkspaceStyle.markupFine, WorkspaceStyle.markupMedium, WorkspaceStyle.markupBroad], id: \.self) { value in
          Button { width = value } label: {
            Capsule().fill(width == value ? WorkspaceStyle.text(scheme) : WorkspaceStyle.secondaryText(scheme))
              .frame(width: 22, height: value).frame(width: 36, height: 36)
              .background(width == value ? WorkspaceStyle.selected(scheme) : .clear, in: RoundedRectangle(cornerRadius: 8))
              .contentShape(Rectangle())
          }.buttonStyle(.plain)
            .accessibilityLabel(value == WorkspaceStyle.markupFine ? "Fine line" : value == WorkspaceStyle.markupMedium ? "Medium line" : "Broad line")
            .accessibilityAddTraits(width == value ? .isSelected : [])
            .accessibilityValue(width == value ? "On" : "Off")
            .help(value == WorkspaceStyle.markupFine ? "Fine line" : value == WorkspaceStyle.markupMedium ? "Medium line" : "Broad line")
        }
      }
    }
    .padding(WorkspaceStyle.space2)
    .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(WorkspaceStyle.line(scheme), lineWidth: 1))
  }

  private func toolSymbol(_ tool: MarkTool) -> WorkspaceGlyphName {
    switch tool {
    case .pen: .pen
    case .arrow: .arrowDiagonal
    case .rectangle: .rectangle
    case .text: .text
    }
  }

  private func toolName(_ tool: MarkTool) -> String {
    switch tool {
    case .pen: "Pen"
    case .arrow: "Arrow"
    case .rectangle: "Rectangle"
    case .text: "Text label"
    }
  }

  private var shapeInput: Bool {
    #if os(iOS)
      tool != .pen
    #else
      true
    #endif
  }
  private func attach() async {
    guard let image, let actions else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      var pencil: CGImage?
      #if os(iOS)
        if !history.document.pencil.isEmpty {
          pencil = try PKDrawing(data: history.document.pencil).image(
            from: CGRect(x: 0, y: 0, width: image.width, height: image.height), scale: 1
          ).cgImage
        }
      #endif
      let png = try MarkupRaster.flatten(
        image, shapes: history.document.shapes, pencil: pencil,
        reference: WorkspaceStyle.mediaViewerHeight, labelSize: WorkspaceStyle.markupLabelSize,
        color: cgColor)
      guard png.count <= 20 * 1024 * 1024 else {
        throw ClientError.response(413, "Marked-up image exceeds 20 MB")
      }
      try await actions.upload(attachment, png)
      done()
    } catch { self.error = error.localizedDescription }
  }
}

#if os(iOS)
  private struct MarkupPencilSurface: UIViewRepresentable {
    var data: Data
    var nativeSize: CGSize
    var color: UIColor
    var width: CGFloat
    var enabled: Bool
    var changed: (Data) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> PKCanvasView {
      let view = PKCanvasView()
      view.backgroundColor = .clear
      view.isOpaque = false
      view.drawingPolicy = .anyInput
      view.isScrollEnabled = false
      view.delegate = context.coordinator
      return view
    }
    func updateUIView(_ view: PKCanvasView, context: Context) {
      context.coordinator.parent = self
      view.isUserInteractionEnabled = enabled
      view.tool = PKInkingTool(.pen, color: color, width: width)
      context.coordinator.restore(view)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PKCanvasView, context: Context)
      -> CGSize?
    {
      let size = proposal.replacingUnspecifiedDimensions()
      uiView.bounds.size = size
      context.coordinator.restore(uiView)
      return size
    }
    final class Coordinator: NSObject, PKCanvasViewDelegate {
      var parent: MarkupPencilSurface
      var restoring = false
      var usingTool = false
      var displayed = Data()
      init(_ parent: MarkupPencilSurface) { self.parent = parent }
      func restore(_ view: PKCanvasView) {
        guard view.bounds.width > 0, view.bounds.height > 0 else { return }
        let drawing = (try? PKDrawing(data: parent.data)) ?? PKDrawing()
        let fitted = drawing.transformed(
          using: CGAffineTransform(
            scaleX: view.bounds.width / parent.nativeSize.width,
            y: view.bounds.height / parent.nativeSize.height))
        guard fitted.dataRepresentation() != view.drawing.dataRepresentation() else { return }
        restoring = true
        view.drawing = fitted
        displayed = fitted.dataRepresentation()
        restoring = false
      }
      func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) { usingTool = true }
      func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        usingTool = false
        canvasViewDrawingDidChange(canvasView)
      }
      func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !usingTool, !restoring, canvasView.bounds.width > 0, canvasView.bounds.height > 0,
          canvasView.drawing.dataRepresentation() != displayed
        else { return }
        displayed = canvasView.drawing.dataRepresentation()
        let native = canvasView.drawing.transformed(
          using: CGAffineTransform(
            scaleX: parent.nativeSize.width / canvasView.bounds.width,
            y: parent.nativeSize.height / canvasView.bounds.height))
        parent.changed(native.dataRepresentation())
      }
    }
  }
#endif
