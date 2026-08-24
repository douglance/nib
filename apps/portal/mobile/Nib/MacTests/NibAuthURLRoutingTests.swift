import Foundation
import Testing
@testable import Nib

@Suite("Nib auth URL routing")
struct NibAuthURLRoutingTests {
    private let serviceURL = URL(string: "https://nibtool.com")!

    @Test("Routes same-origin verification links to the auth verifier")
    func routesVerificationLink() {
        let url = URL(string: "https://nibtool.com/auth/verify?challenge=challenge&token=token")!

        #expect(NibAuthURLRouting.isVerificationURL(url, serviceURL: serviceURL))
    }

    @Test(
        "Rejects URLs that are not same-origin verification links",
        arguments: [
            "http://nibtool.com/auth/verify?challenge=challenge&token=token",
            "https://example.com/auth/verify?challenge=challenge&token=token",
            "https://nibtool.com/requests/request-id",
            "nib://request/request-id",
        ]
    )
    func rejectsOtherURLs(_ value: String) {
        let url = URL(string: value)!

        #expect(!NibAuthURLRouting.isVerificationURL(url, serviceURL: serviceURL))
    }
}
