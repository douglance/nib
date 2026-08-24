import Foundation
import XCTest
@testable import Nib

final class NibAuthPollingPolicyTests: XCTestCase {
    func testRetriesTransientNetworkFailures() {
        XCTAssertTrue(NibAuthPollingPolicy.shouldRetry(URLError(.networkConnectionLost)))
        XCTAssertTrue(NibAuthPollingPolicy.shouldRetry(URLError(.notConnectedToInternet)))
        XCTAssertTrue(NibAuthPollingPolicy.shouldRetry(URLError(.timedOut)))
    }

    func testDoesNotRetryCancellationOrInvalidRequests() {
        XCTAssertFalse(NibAuthPollingPolicy.shouldRetry(URLError(.cancelled)))
        XCTAssertFalse(NibAuthPollingPolicy.shouldRetry(URLError(.badURL)))
        XCTAssertFalse(NibAuthPollingPolicy.shouldRetry(NSError(domain: "Nib", code: 1)))
    }
}
