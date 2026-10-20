import Foundation
import Security
import Testing
@testable import DeployCore

@Test func unsignedBuildsExplainWhyLoginIsNotKept() {
    let failure = CredentialVault.saveFailure(ClientError.response(Int(errSecMissingEntitlement), "Unable to save login in Keychain"))
    #expect(failure.message.contains("isn’t code signed"))
    #expect(!failure.retryable)
}

@Test func lockedKeychainOffersRetry() {
    let failure = CredentialVault.saveFailure(ClientError.response(Int(errSecInteractionNotAllowed), "Unable to save login in Keychain"))
    #expect(failure.message.contains("locked"))
    #expect(failure.retryable)
}

@Test func otherKeychainErrorsNameTheStatus() {
    let failure = CredentialVault.saveFailure(ClientError.response(-25299, "Unable to update login in Keychain"))
    #expect(failure.message.contains("-25299"))
    #expect(failure.retryable)
}
