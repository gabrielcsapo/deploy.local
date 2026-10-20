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
      Button("Mark up") { open = true }.buttonStyle(.workspaceLink)
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
      HStack(spacing: WorkspaceStyle.space3) {
        Button(busy ? "Uploading…" : "Attach to message") { Task { await attach() } }
          .buttonStyle(.workspacePrimary).disabled(image == nil || busy)
        Button("Cancel") { dismiss() }.buttonStyle(.workspaceLink).disabled(busy)
      }
      ScrollView(.horizontal) {
        HStack(spacing: WorkspaceStyle.space3) {
          ForEach(MarkTool.allCases, id: \.self) { item in
            Button(item == .text ? "Text label" : item.rawValue.capitalized) { tool = item }
              .buttonStyle(.workspaceLink).fontWeight(tool == item ? .semibold : .regular)
              .foregroundStyle(
                tool == item ? WorkspaceStyle.accent(scheme) : WorkspaceStyle.secondaryText(scheme)
              )
              .accessibilityAddTraits(tool == item ? .isSelected : [])
          }
          Button("Undo") { history.undo() }.disabled(history.past.isEmpty)
          Button("Redo") { history.redo() }.disabled(history.future.isEmpty)
          Button("Clear") { history.change(MarkDocument()) }.disabled(
            history.document == MarkDocument())
        }.buttonStyle(.workspaceLink)
      }.fixedSize(horizontal: false, vertical: true).disabled(busy)
      ScrollView(.horizontal) {
        HStack(spacing: WorkspaceStyle.space3) {
          ForEach(MarkColor.allCases, id: \.self) { item in
            Button(item.rawValue.capitalized) { color = item }.foregroundStyle(markColor(item))
              .fontWeight(color == item ? .semibold : .regular)
              .accessibilityAddTraits(color == item ? .isSelected : [])
          }
          ForEach(
            [WorkspaceStyle.markupFine, WorkspaceStyle.markupMedium, WorkspaceStyle.markupBroad],
            id: \.self
          ) { value in
            Button(
              value == WorkspaceStyle.markupFine
                ? "Fine" : value == WorkspaceStyle.markupMedium ? "Medium" : "Broad"
            ) { width = value }
            .fontWeight(width == value ? .semibold : .regular)
            .accessibilityAddTraits(width == value ? .isSelected : [])
          }
        }.buttonStyle(.workspaceLink)
      }.fixedSize(horizontal: false, vertical: true).disabled(busy)
      if tool == .text {
        TextField("Text label", text: $label).textFieldStyle(.roundedBorder).disabled(busy)
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
