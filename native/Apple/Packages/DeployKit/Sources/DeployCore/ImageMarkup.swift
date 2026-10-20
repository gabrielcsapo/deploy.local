import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct MarkPoint: Codable, Equatable, Sendable {
  public var x: Double
  public var y: Double
  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}
public enum MarkTool: String, Codable, CaseIterable, Sendable { case pen, arrow, rectangle, text }
public enum MarkColor: String, Codable, CaseIterable, Sendable { case accent, attention, failed }
public struct MarkShape: Codable, Equatable, Sendable {
  public var tool: MarkTool
  public var points: [MarkPoint]
  public var color: MarkColor
  public var width: Double
  public var text: String
  public init(
    tool: MarkTool, points: [MarkPoint], color: MarkColor, width: Double, text: String = ""
  ) {
    self.tool = tool
    self.points = points
    self.color = color
    self.width = width
    self.text = text
  }
}
public struct MarkDocument: Codable, Equatable, Sendable {
  public var shapes: [MarkShape] = []
  public var pencil: Data = Data()
  public init() {}
}
public struct MarkHistory: Sendable {
  public private(set) var document = MarkDocument()
  public private(set) var past: [MarkDocument] = []
  public private(set) var future: [MarkDocument] = []
  public init() {}
  public mutating func change(_ document: MarkDocument) {
    guard document != self.document else { return }
    past.append(self.document)
    self.document = document
    future = []
  }
  public mutating func undo() {
    guard let previous = past.popLast() else { return }
    future.append(document)
    document = previous
  }
  public mutating func redo() {
    guard let next = future.popLast() else { return }
    past.append(document)
    document = next
  }
}

/// Pixel dimensions come from the decoded source, never the fitted editor or screen scale.
public enum MarkupRaster {
  public static func source(_ data: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: max(width, height),
        ] as CFDictionary)
    else { throw ClientError.invalidResponse }
    return image
  }
  public static func draw(
    _ shapes: [MarkShape], in context: CGContext, size: CGSize,
    reference: CGFloat, labelSize: CGFloat, color: (MarkColor) -> CGColor
  ) {
    let scale = min(size.width, size.height) / reference
    context.saveGState()
    defer { context.restoreGState() }
    context.setLineCap(.round)
    context.setLineJoin(.round)
    for shape in shapes {
      let points = shape.points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
      guard let a = points.first, let b = points.last else { continue }
      context.setStrokeColor(color(shape.color))
      context.setFillColor(color(shape.color))
      context.setLineWidth(shape.width * scale)
      context.beginPath()
      context.move(to: a)
      switch shape.tool {
      case .rectangle:
        context.addRect(
          CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y)))
      case .text:
        context.saveGState()
        context.translateBy(x: a.x, y: a.y + labelSize * scale)
        context.scaleBy(x: 1, y: -1)
        let font = CTFontCreateUIFontForLanguage(.system, labelSize * scale, nil)!
        let string = NSAttributedString(
          string: shape.text,
          attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(shape.color),
          ])
        context.textPosition = .zero
        CTLineDraw(CTLineCreateWithAttributedString(string), context)
        context.restoreGState()
      case .pen, .arrow:
        for point in points.dropFirst() { context.addLine(to: point) }
        if points.count == 1 { context.addLine(to: CGPoint(x: a.x + 0.01, y: a.y)) }
        if shape.tool == .arrow {
          let angle = atan2(b.y - a.y, b.x - a.x)
          let length = shape.width * scale * 4
          for offset in [-CGFloat.pi / 6, CGFloat.pi / 6] {
            context.move(to: b)
            context.addLine(
              to: CGPoint(
                x: b.x - length * cos(angle + offset), y: b.y - length * sin(angle + offset)))
          }
        }
      }
      context.strokePath()
    }
  }
  public static func flatten(
    _ image: CGImage, shapes: [MarkShape], pencil: CGImage? = nil,
    reference: CGFloat, labelSize: CGFloat, color: (MarkColor) -> CGColor
  ) throws -> Data {
    guard
      let context = CGContext(
        data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw ClientError.invalidResponse }
    let size = CGSize(width: image.width, height: image.height)
    let rect = CGRect(origin: .zero, size: size)
    context.draw(image, in: rect)
    if let pencil { context.draw(pencil, in: rect) }
    context.translateBy(x: 0, y: size.height)
    context.scaleBy(x: 1, y: -1)
    draw(shapes, in: context, size: size, reference: reference, labelSize: labelSize, color: color)
    let data = NSMutableData()
    guard let result = context.makeImage(),
      let destination = CGImageDestinationCreateWithData(
        data, UTType.png.identifier as CFString, 1, nil)
    else { throw ClientError.invalidResponse }
    CGImageDestinationAddImage(destination, result, nil)
    guard CGImageDestinationFinalize(destination) else { throw ClientError.invalidResponse }
    return data as Data
  }
}
