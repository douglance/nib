// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "NibKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v14),
        .visionOS(.v2),
        .watchOS(.v11)
    ],
    products: [
        .library(name: "NibDomain", targets: ["NibDomain"]),
        .library(name: "NibCloud", targets: ["NibCloud"]),
        .library(name: "NibFeatures", targets: ["NibFeatures"]),
        .library(name: "NibDocument", targets: ["NibDocument"]),
        .library(name: "NibNotifications", targets: ["NibNotifications"])
    ],
    targets: [
        .target(name: "NibDomain"),
        .target(name: "NibCloud", dependencies: ["NibDomain"]),
        .target(name: "NibFeatures", dependencies: ["NibCloud", "NibDomain"]),
        .target(
            name: "NibDocument",
            linkerSettings: [
                .linkedLibrary("sqlite3", .when(platforms: [.macOS, .iOS, .visionOS, .watchOS]))
            ]
        ),
        .target(name: "NibNotifications"),
        .testTarget(name: "NibDomainTests", dependencies: ["NibDomain"]),
        .testTarget(name: "NibCloudTests", dependencies: ["NibCloud", "NibDomain"]),
        .testTarget(name: "NibFeaturesTests", dependencies: ["NibFeatures", "NibDomain"]),
        .testTarget(name: "NibNotificationsTests", dependencies: ["NibNotifications"]),
        .testTarget(
            name: "NibDocumentTests",
            dependencies: ["NibDocument"],
            linkerSettings: [
                .linkedLibrary("sqlite3", .when(platforms: [.macOS, .iOS, .visionOS, .watchOS]))
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
