import Testing
@testable import DeployCore

struct V2ReviewZoomTests {
    @Test func aWebScreenZoomsOutUntilItsWholeWidthIsInView() {
        #expect(abs(V2ReviewZoom.fit(content: 1440, viewport: 390) - 390.0 / 1440.0) < 0.0001)
        #expect(abs(V2ReviewZoom.fit(content: 700, viewport: 390) - 390.0 / 700.0) < 0.0001)
    }

    @Test func aPhoneScreenStaysAtItsOwnSize() {
        #expect(V2ReviewZoom.fit(content: 390, viewport: 390) == 1)
        #expect(V2ReviewZoom.fit(content: 390, viewport: 430) == 1)
    }

    @Test func aScreenWithNoSizeYetDoesNotZoom() {
        #expect(V2ReviewZoom.fit(content: 0, viewport: 390) == 1)
        #expect(V2ReviewZoom.fit(content: 1440, viewport: 0) == 1)
    }
}
