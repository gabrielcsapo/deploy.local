import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import DeployCore

final class ImageMarkupTests: XCTestCase {
  func testHistoryAndSerialization() throws {
    var history = MarkHistory()
    var document = MarkDocument()
    let shape = MarkShape(
      tool: .arrow, points: [.init(x: 0.1, y: 0.2), .init(x: 0.8, y: 0.9)], color: .attention,
      width: 4)
    document.shapes.append(shape)
    document.pencil = Data([1, 2, 3])
    history.change(document)
    history.change(MarkDocument())
    history.undo()
    XCTAssertEqual(history.document, document)
    history.undo()
    XCTAssertEqual(history.document, MarkDocument())
    history.redo()
    XCTAssertEqual(history.document, document)
    history.change(MarkDocument())
    XCTAssertTrue(history.future.isEmpty)
    let encoded = try JSONEncoder().encode(document)
    XCTAssertEqual(try JSONDecoder().decode(MarkDocument.self, from: encoded), document)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(Set(json.keys), Set(["shapes", "pencil"]))
  }
  func testFlattenPreservesNativeSizeAndOrientation() throws {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: 73, height: 121, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    let image = try XCTUnwrap(context.makeImage())
    let shape = MarkShape(
      tool: .rectangle, points: [.init(x: 0.1, y: 0.1), .init(x: 0.9, y: 0.9)], color: .failed,
      width: 4)
    let png = try MarkupRaster.flatten(image, shapes: [shape], reference: 600, labelSize: 17) { _ in
      CGColor(gray: 1, alpha: 1)
    }
    let decoded = try MarkupRaster.source(png)
    XCTAssertEqual(decoded.width, 73)
    XCTAssertEqual(decoded.height, 121)
    XCTAssertThrowsError(try MarkupRaster.source(Data()))
    // Phone JPEGs commonly store portrait orientation separately from their pixels.
    let jpeg = NSMutableData()
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: 6] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let oriented = try MarkupRaster.source(jpeg as Data)
    XCTAssertEqual(oriented.width, 121)
    XCTAssertEqual(oriented.height, 73)
    let orientedPNG = try MarkupRaster.flatten(oriented, shapes: [], reference: 600, labelSize: 17)
    { _ in CGColor(gray: 1, alpha: 1) }
    let orientedResult = try MarkupRaster.source(orientedPNG)
    XCTAssertEqual(orientedResult.width, 121)
    XCTAssertEqual(orientedResult.height, 73)
  }
}
