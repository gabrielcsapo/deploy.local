import XCTest
@testable import DeployCore

final class MediaNavigationTests: XCTestCase {
    func testNavigationAndFilmstripSelectionKeepTranscriptOrder() {
        var navigation = MediaNavigation(ids: ["image-run-1", "video-run-2", "image-user"], initialID: "video-run-2")
        XCTAssertEqual(navigation.index, 1)
        XCTAssertTrue(navigation.canGoBack)
        XCTAssertTrue(navigation.canGoForward)
        navigation.step(1)
        XCTAssertEqual(navigation.selectedID, "image-user")
        navigation.step(1)
        XCTAssertEqual(navigation.index, 2)
        XCTAssertFalse(navigation.canGoForward)
        navigation.first()
        navigation.step(-1)
        XCTAssertEqual(navigation.selectedID, "image-run-1")
        XCTAssertFalse(navigation.canGoBack)
        navigation.last()
        XCTAssertEqual(navigation.index, 2)
        navigation.select(1)
        XCTAssertEqual(navigation.selectedID, "video-run-2")
        navigation.select(99)
        XCTAssertEqual(navigation.index, 1)
    }
    func testEmptySingleAndMissingInitialSelection() {
        var empty = MediaNavigation(ids: [], initialID: "missing")
        empty.last(); empty.step(1)
        XCTAssertNil(empty.selectedID)
        XCTAssertFalse(empty.canGoForward)
        var single = MediaNavigation(ids: ["image"], initialID: "missing")
        single.step(-1); single.step(1)
        XCTAssertEqual(single.selectedID, "image")
        XCTAssertFalse(single.canGoBack)
        XCTAssertFalse(single.canGoForward)
    }
}
