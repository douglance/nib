import Foundation
import XCTest
@testable import Nib

private final class AccountDeletionURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var observedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.observedRequest = request
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["content-type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"deleted":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class NibAccountDeletionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AccountDeletionURLProtocol.observedRequest = nil
    }

    func testDeleteAccountUsesAuthenticatedDeleteEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountDeletionURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = NibClient(
            baseURL: URL(string: "https://nib.example.test")!,
            session: session
        )

        let result = try await client.deleteAccount()

        XCTAssertTrue(result.deleted)
        XCTAssertEqual(AccountDeletionURLProtocol.observedRequest?.httpMethod, "DELETE")
        XCTAssertEqual(AccountDeletionURLProtocol.observedRequest?.url?.path, "/api/account")
    }
}
