import Foundation

#if canImport(SQLite3)
import SQLite3
#endif

public enum NibDocumentError: Error, Equatable, Sendable {
    case sqliteUnavailable
    case openFailed(String)
    case invalidDocument(String)
    case sqliteFailure(String)
    case sourceAndDestinationMustDiffer
    case destinationAlreadyExists
}

public struct NibPoint: Hashable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct NibRect: Hashable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct NibAnnotationAnchor: Hashable, Sendable {
    public let pageIndex: Int?
    public let timeMs: Double?

    public init(pageIndex: Int? = nil, timeMs: Double? = nil) {
        self.pageIndex = pageIndex
        self.timeMs = timeMs
    }
}

public enum NibStrokeStyle: String, Hashable, Sendable {
    case solid
    case dashed
    case dotted
}

public enum NibArrowHead: String, Hashable, Sendable {
    case none
    case start
    case end
    case both
}

public enum NibTextAlignment: String, Hashable, Sendable {
    case left
    case center
    case right
}

public enum NibBlurIntensity: String, Hashable, Sendable {
    case low
    case medium
    case high
}

public struct NibAnnotationStyle: Hashable, Sendable {
    public let color: String
    public let opacity: Double
    public let strokeWidth: Double?
    public let strokeStyle: NibStrokeStyle?
    public let fillColor: String?
    public let filled: Bool?
    public let cornerRadius: Double?
    public let arrowHead: NibArrowHead?
    public let fontSize: Double?
    public let textAlignment: NibTextAlignment?
    public let textBackground: String?
    public let maxWidth: Double?
    public let blurIntensity: NibBlurIntensity?

    public init(
        color: String = "#0a84ff",
        opacity: Double = 1,
        strokeWidth: Double? = nil,
        strokeStyle: NibStrokeStyle? = nil,
        fillColor: String? = nil,
        filled: Bool? = nil,
        cornerRadius: Double? = nil,
        arrowHead: NibArrowHead? = nil,
        fontSize: Double? = nil,
        textAlignment: NibTextAlignment? = nil,
        textBackground: String? = nil,
        maxWidth: Double? = nil,
        blurIntensity: NibBlurIntensity? = nil
    ) {
        self.color = color
        self.opacity = opacity
        self.strokeWidth = strokeWidth
        self.strokeStyle = strokeStyle
        self.fillColor = fillColor
        self.filled = filled
        self.cornerRadius = cornerRadius
        self.arrowHead = arrowHead
        self.fontSize = fontSize
        self.textAlignment = textAlignment
        self.textBackground = textBackground
        self.maxWidth = maxWidth
        self.blurIntensity = blurIntensity
    }
}

public enum NibAnnotationKind: Hashable, Sendable {
    case rectangle(NibRect)
    case arrow(start: NibPoint, end: NibPoint)
    case line(start: NibPoint, end: NibPoint)
    case ellipse(center: NibPoint, radiusX: Double, radiusY: Double)
    case highlight(NibRect)
    case blur(NibRect)
    case text(position: NibPoint, content: String)
    case number(position: NibPoint, value: UInt32, radius: Double)
    case crop(NibRect)
    case path(points: [NibPoint])
    case image(region: NibRect, assetHash: String)

    public var storageType: String {
        switch self {
        case .rectangle:
            return "rectangle"
        case .arrow:
            return "arrow"
        case .line:
            return "line"
        case .ellipse:
            return "ellipse"
        case .highlight:
            return "highlight"
        case .blur:
            return "blur"
        case .text:
            return "text"
        case .number:
            return "number"
        case .crop:
            return "crop"
        case .path:
            return "path"
        case .image:
            return "image"
        }
    }
}

public struct NibAnnotation: Identifiable, Hashable, Sendable {
    public let id: String
    public let kind: NibAnnotationKind
    public let anchor: NibAnnotationAnchor
    public let style: NibAnnotationStyle
    public let source: String
    public let zIndex: Int
    public let visible: Bool
    public let locked: Bool
    public let groupID: Int?
    public let createdAt: Date
    public let modifiedAt: Date

    public init(
        id: String,
        kind: NibAnnotationKind,
        anchor: NibAnnotationAnchor = NibAnnotationAnchor(),
        style: NibAnnotationStyle = NibAnnotationStyle(),
        source: String = "human",
        zIndex: Int = 0,
        visible: Bool = true,
        locked: Bool = false,
        groupID: Int? = nil,
        createdAt: Date = Date(),
        modifiedAt: Date = Date()
    ) {
        self.id = id
        self.kind = kind
        self.anchor = anchor
        self.style = style
        self.source = source
        self.zIndex = zIndex
        self.visible = visible
        self.locked = locked
        self.groupID = groupID
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
    }

    public func replacing(
        kind: NibAnnotationKind? = nil,
        anchor: NibAnnotationAnchor? = nil,
        style: NibAnnotationStyle? = nil,
        visible: Bool? = nil,
        locked: Bool? = nil,
        groupID: Int?? = nil,
        modifiedAt: Date = Date()
    ) -> NibAnnotation {
        NibAnnotation(
            id: id,
            kind: kind ?? self.kind,
            anchor: anchor ?? self.anchor,
            style: style ?? self.style,
            source: source,
            zIndex: zIndex,
            visible: visible ?? self.visible,
            locked: locked ?? self.locked,
            groupID: groupID ?? self.groupID,
            createdAt: createdAt,
            modifiedAt: modifiedAt
        )
    }
}

public struct NibDocumentImage: Hashable, Sendable {
    public let data: Data
    public let format: String
    public let width: Int
    public let height: Int
    public let importedAt: Date
    public let originalPath: String?

    public init(data: Data, format: String, width: Int, height: Int, importedAt: Date, originalPath: String?) {
        self.data = data
        self.format = format
        self.width = width
        self.height = height
        self.importedAt = importedAt
        self.originalPath = originalPath
    }
}

public struct NibDocumentAsset: Hashable, Sendable {
    public let hash: String
    public let bytes: Data
    public let format: String
    public let width: Int
    public let height: Int

    public init(hash: String, bytes: Data, format: String, width: Int, height: Int) {
        self.hash = hash
        self.bytes = bytes
        self.format = format
        self.width = width
        self.height = height
    }
}

public struct NibDocumentSession: Hashable, Sendable {
    public let guiPID: Int?
    public let openedAt: Date?
    public let lastActivity: Date?

    public init(guiPID: Int?, openedAt: Date?, lastActivity: Date?) {
        self.guiPID = guiPID
        self.openedAt = openedAt
        self.lastActivity = lastActivity
    }
}

public struct NibDocumentMessage: Identifiable, Hashable, Sendable {
    public let id: Int
    public let content: String
    public let source: String
    public let read: Bool
    public let createdAt: Date

    public init(id: Int, content: String, source: String, read: Bool, createdAt: Date) {
        self.id = id
        self.content = content
        self.source = source
        self.read = read
        self.createdAt = createdAt
    }
}

public struct NibDocument: Hashable, Sendable {
    public let sourceURL: URL?
    public let schemaVersion: Int
    public let fileID: String
    public let image: NibDocumentImage
    public let annotations: [NibAnnotation]
    public let assets: [NibDocumentAsset]
    public let metadata: [String: String]
    public let session: NibDocumentSession?
    public let messages: [NibDocumentMessage]

    public init(
        sourceURL: URL? = nil,
        schemaVersion: Int = 2,
        fileID: String,
        image: NibDocumentImage,
        annotations: [NibAnnotation] = [],
        assets: [NibDocumentAsset] = [],
        metadata: [String: String] = [:],
        session: NibDocumentSession? = nil,
        messages: [NibDocumentMessage] = []
    ) {
        self.sourceURL = sourceURL
        self.schemaVersion = schemaVersion
        self.fileID = fileID
        self.image = image
        self.annotations = annotations
        self.assets = assets
        self.metadata = metadata
        self.session = session
        self.messages = messages
    }

    public func replacing(
        annotations: [NibAnnotation]? = nil,
        metadata: [String: String]? = nil,
        sourceURL: URL?? = nil
    ) -> NibDocument {
        NibDocument(
            sourceURL: sourceURL ?? self.sourceURL,
            schemaVersion: schemaVersion,
            fileID: fileID,
            image: image,
            annotations: annotations ?? self.annotations,
            assets: assets,
            metadata: metadata ?? self.metadata,
            session: session,
            messages: messages
        )
    }
}

public enum NibEditorTool: String, Hashable, Sendable, CaseIterable {
    case select
    case pan
    case rectangle
    case arrow
    case line
    case ellipse
    case highlight
    case blur
    case text
    case number
    case crop
    case path
    case image
}

public enum NibEditorAction: Hashable, Sendable {
    case setTool(NibEditorTool)
    case select(Set<String>)
    case clearSelection
    case setPanOffset(NibPoint)
    case addAnnotation(NibAnnotation)
    case updateAnnotation(NibAnnotation)
    case deleteAnnotations(Set<String>)
    case deleteSelected
    case setVisibility(ids: Set<String>, visible: Bool)
    case setLock(ids: Set<String>, locked: Bool)
    case group(Set<String>)
    case ungroup(Set<String>)
    case undo
    case redo
}

public struct NibEditorState: Hashable, Sendable {
    public let document: NibDocument
    public let tool: NibEditorTool
    public let selectedAnnotationIDs: Set<String>
    public let panOffset: NibPoint
    public let undoDocuments: [NibDocument]
    public let redoDocuments: [NibDocument]

    public init(
        document: NibDocument,
        tool: NibEditorTool = .select,
        selectedAnnotationIDs: Set<String> = [],
        panOffset: NibPoint = NibPoint(x: 0, y: 0),
        undoDocuments: [NibDocument] = [],
        redoDocuments: [NibDocument] = []
    ) {
        self.document = document
        self.tool = tool
        self.selectedAnnotationIDs = selectedAnnotationIDs
        self.panOffset = panOffset
        self.undoDocuments = undoDocuments
        self.redoDocuments = redoDocuments
    }
}

public enum NibEditorReducer {
    public static func reduce(_ state: NibEditorState, _ action: NibEditorAction) -> NibEditorState {
        switch action {
        case .setTool(let tool):
            return NibEditorState(
                document: state.document,
                tool: tool,
                selectedAnnotationIDs: state.selectedAnnotationIDs,
                panOffset: state.panOffset,
                undoDocuments: state.undoDocuments,
                redoDocuments: state.redoDocuments
            )
        case .select(let ids):
            return NibEditorState(
                document: state.document,
                tool: state.tool,
                selectedAnnotationIDs: ids,
                panOffset: state.panOffset,
                undoDocuments: state.undoDocuments,
                redoDocuments: state.redoDocuments
            )
        case .clearSelection:
            return NibEditorState(
                document: state.document,
                tool: state.tool,
                selectedAnnotationIDs: [],
                panOffset: state.panOffset,
                undoDocuments: state.undoDocuments,
                redoDocuments: state.redoDocuments
            )
        case .setPanOffset(let offset):
            return NibEditorState(
                document: state.document,
                tool: state.tool,
                selectedAnnotationIDs: state.selectedAnnotationIDs,
                panOffset: offset,
                undoDocuments: state.undoDocuments,
                redoDocuments: state.redoDocuments
            )
        case .addAnnotation(let annotation):
            return changed(state, document: state.document.replacing(annotations: state.document.annotations + [annotation]))
        case .updateAnnotation(let annotation):
            let updated = state.document.annotations.map { $0.id == annotation.id ? annotation : $0 }
            return changed(state, document: state.document.replacing(annotations: updated))
        case .deleteAnnotations(let ids):
            let updated = state.document.annotations.filter { !ids.contains($0.id) || $0.locked }
            return changed(state, document: state.document.replacing(annotations: updated), selection: state.selectedAnnotationIDs.subtracting(ids))
        case .deleteSelected:
            let updated = state.document.annotations.filter { !state.selectedAnnotationIDs.contains($0.id) || $0.locked }
            return changed(state, document: state.document.replacing(annotations: updated), selection: [])
        case .setVisibility(let ids, let visible):
            return changed(state, document: state.document.replacing(annotations: state.document.annotations.map {
                ids.contains($0.id) ? $0.replacing(visible: visible) : $0
            }))
        case .setLock(let ids, let locked):
            return changed(state, document: state.document.replacing(annotations: state.document.annotations.map {
                ids.contains($0.id) ? $0.replacing(locked: locked) : $0
            }))
        case .group(let ids):
            guard ids.count > 1 else { return state }
            let nextID = (state.document.annotations.compactMap(\.groupID).max() ?? 0) + 1
            return changed(state, document: state.document.replacing(annotations: state.document.annotations.map {
                ids.contains($0.id) ? $0.replacing(groupID: .some(nextID)) : $0
            }))
        case .ungroup(let ids):
            return changed(state, document: state.document.replacing(annotations: state.document.annotations.map {
                ids.contains($0.id) ? $0.replacing(groupID: .some(nil)) : $0
            }))
        case .undo:
            guard let previous = state.undoDocuments.last else { return state }
            return NibEditorState(
                document: previous,
                tool: state.tool,
                selectedAnnotationIDs: state.selectedAnnotationIDs.intersection(previous.annotations.map(\.id)),
                panOffset: state.panOffset,
                undoDocuments: Array(state.undoDocuments.dropLast()),
                redoDocuments: state.redoDocuments + [state.document]
            )
        case .redo:
            guard let next = state.redoDocuments.last else { return state }
            return NibEditorState(
                document: next,
                tool: state.tool,
                selectedAnnotationIDs: state.selectedAnnotationIDs.intersection(next.annotations.map(\.id)),
                panOffset: state.panOffset,
                undoDocuments: state.undoDocuments + [state.document],
                redoDocuments: Array(state.redoDocuments.dropLast())
            )
        }
    }

    private static func changed(_ state: NibEditorState, document: NibDocument, selection: Set<String>? = nil) -> NibEditorState {
        guard document != state.document else { return state }
        return NibEditorState(
            document: document,
            tool: state.tool,
            selectedAnnotationIDs: selection ?? state.selectedAnnotationIDs,
            panOffset: state.panOffset,
            undoDocuments: state.undoDocuments + [state.document],
            redoDocuments: []
        )
    }
}

public enum NibDocumentStore {
    public static func open(at url: URL) throws -> NibDocument {
        #if canImport(SQLite3)
        let database = try SQLiteDatabase.open(url: url, flags: SQLITE_OPEN_READONLY)
        defer { database.close() }
        return try database.readDocument(sourceURL: url)
        #else
        throw NibDocumentError.sqliteUnavailable
        #endif
    }

    public static func export(_ document: NibDocument, to destinationURL: URL, derivedFromFileID: String? = nil) throws {
        guard let sourceURL = document.sourceURL else {
            throw NibDocumentError.invalidDocument("Export requires a document opened from an existing .nib source")
        }

        let sourcePath = sourceURL.standardizedFileURL.path
        let destinationPath = destinationURL.standardizedFileURL.path
        guard sourcePath != destinationPath else {
            throw NibDocumentError.sourceAndDestinationMustDiffer
        }
        guard !FileManager.default.fileExists(atPath: destinationPath) else {
            throw NibDocumentError.destinationAlreadyExists
        }

        try FileManager.default.copyItem(at: sourceURL, to: destinationURL)

        #if canImport(SQLite3)
        do {
            let database = try SQLiteDatabase.open(url: destinationURL, flags: SQLITE_OPEN_READWRITE)
            defer { database.close() }
            var metadata = document.metadata
            metadata["derivedFromFileID"] = derivedFromFileID ?? document.fileID
            try database.replaceDocumentContent(document.replacing(metadata: metadata, sourceURL: .some(destinationURL)))
        } catch {
            try? FileManager.default.removeItem(at: destinationURL)
            throw error
        }
        #else
        throw NibDocumentError.sqliteUnavailable
        #endif
    }
}

#if canImport(SQLite3)
private final class SQLiteDatabase {
    private var handle: OpaquePointer?

    private init(handle: OpaquePointer?) {
        self.handle = handle
    }

    static func open(url: URL, flags: Int32) throws -> SQLiteDatabase {
        var handle: OpaquePointer?
        let result = sqlite3_open_v2(url.path, &handle, flags, nil)
        guard result == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unable to open database"
            if let handle {
                sqlite3_close(handle)
            }
            throw NibDocumentError.openFailed(message)
        }
        return SQLiteDatabase(handle: handle)
    }

    func close() {
        if let handle {
            sqlite3_close(handle)
            self.handle = nil
        }
    }

    func readDocument(sourceURL: URL) throws -> NibDocument {
        let version = try readSchemaVersion()
        let metadata = try readMetadata()
        let image = try readImage()
        let annotations = try readAnnotations()
        let assets = try readAssets()
        let session = try readSession()
        let messages = try readMessages()
        let fileID = metadata["fileID"] ?? metadata["fileId"] ?? sourceURL.deletingPathExtension().lastPathComponent

        return NibDocument(
            sourceURL: sourceURL,
            schemaVersion: version,
            fileID: fileID,
            image: image,
            annotations: annotations,
            assets: assets,
            metadata: metadata,
            session: session,
            messages: messages
        )
    }

    func replaceDocumentContent(_ document: NibDocument) throws {
        try execute("BEGIN IMMEDIATE")
        do {
            try replaceMetadata(document.metadata)
            try replaceAnnotations(document.annotations)
            try replaceAssets(document.assets)
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func readSchemaVersion() throws -> Int {
        try query("SELECT version FROM schema_version LIMIT 1") { statement in
            guard sqlite3_step(statement) == SQLITE_ROW else {
                throw NibDocumentError.invalidDocument("missing schema_version")
            }
            return Int(sqlite3_column_int64(statement, 0))
        }
    }

    private func readImage() throws -> NibDocumentImage {
        try query("SELECT data, format, width, height, imported_at, original_path FROM image WHERE id = 1") { statement in
            guard sqlite3_step(statement) == SQLITE_ROW else {
                throw NibDocumentError.invalidDocument("missing image row")
            }
            return NibDocumentImage(
                data: sqliteBlob(statement, 0),
                format: sqliteText(statement, 1) ?? "",
                width: Int(sqlite3_column_int64(statement, 2)),
                height: Int(sqlite3_column_int64(statement, 3)),
                importedAt: sqliteDate(statement, 4),
                originalPath: sqliteText(statement, 5)
            )
        }
    }

    private func readMetadata() throws -> [String: String] {
        try rows("SELECT key, value FROM metadata").reduce(into: [:]) { result, row in
            guard let key = row["key"]?.string else { return }
            result[key] = row["value"]?.string ?? ""
        }
    }

    private func readAnnotations() throws -> [NibAnnotation] {
        try rows("SELECT * FROM annotations ORDER BY z_index ASC, id ASC").map { row in
            guard let id = row["id"]?.string else {
                throw NibDocumentError.invalidDocument("annotation row missing id")
            }
            let type = row["type"]?.string ?? ""
            let dataString = row["data"]?.string ?? "{}"
            let data = try JSONObject.parse(dataString)
            let color = row["color"]?.string ?? "#0a84ff"
            let style = style(type: type, data: data, color: color)
            let anchor = NibAnnotationAnchor(
                pageIndex: row.firstInt(["page_index", "pageIndex"]) ?? data.int("pageIndex"),
                timeMs: row.firstDouble(["time_ms", "timeMs"]) ?? data.optionalDouble("timeMs")
            )

            return NibAnnotation(
                id: id,
                kind: try kind(type: type, data: data),
                anchor: anchor,
                style: style,
                source: row["source"]?.string ?? "human",
                zIndex: row["z_index"]?.int ?? 0,
                visible: (row["visible"]?.int ?? 1) != 0,
                locked: (row["locked"]?.int ?? 0) != 0,
                groupID: row["group_id"]?.optionalInt,
                createdAt: row["created_at"]?.date ?? Date(timeIntervalSince1970: 0),
                modifiedAt: row["modified_at"]?.date ?? Date(timeIntervalSince1970: 0)
            )
        }
    }

    private func readAssets() throws -> [NibDocumentAsset] {
        guard try tableExists("assets") else { return [] }
        return try rows("SELECT hash, bytes, format, width, height FROM assets ORDER BY hash ASC").map { row in
            NibDocumentAsset(
                hash: row["hash"]?.string ?? "",
                bytes: row["bytes"]?.data ?? Data(),
                format: row["format"]?.string ?? "",
                width: row["width"]?.int ?? 0,
                height: row["height"]?.int ?? 0
            )
        }
    }

    private func readSession() throws -> NibDocumentSession? {
        guard try tableExists("session") else { return nil }
        return try query("SELECT gui_pid, opened_at, last_activity FROM session WHERE id = 1") { statement in
            guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
            return NibDocumentSession(
                guiPID: sqliteNullableInt(statement, 0),
                openedAt: sqliteNullableDate(statement, 1),
                lastActivity: sqliteNullableDate(statement, 2)
            )
        }
    }

    private func readMessages() throws -> [NibDocumentMessage] {
        guard try tableExists("messages") else { return [] }
        return try rows("SELECT id, content, source, read, created_at FROM messages ORDER BY id ASC").map { row in
            NibDocumentMessage(
                id: row["id"]?.int ?? 0,
                content: row["content"]?.string ?? "",
                source: row["source"]?.string ?? "agent",
                read: (row["read"]?.int ?? 0) != 0,
                createdAt: row["created_at"]?.date ?? Date(timeIntervalSince1970: 0)
            )
        }
    }

    private func replaceMetadata(_ metadata: [String: String]) throws {
        try execute("DELETE FROM metadata")
        for (key, value) in metadata.sorted(by: { $0.key < $1.key }) {
            try update("INSERT INTO metadata (key, value) VALUES (?1, ?2)", bindings: [.text(key), .text(value)])
        }
    }

    private func replaceAssets(_ assets: [NibDocumentAsset]) throws {
        guard try tableExists("assets") else { return }
        try execute("DELETE FROM assets")
        for asset in assets {
            try update(
                "INSERT INTO assets (hash, bytes, format, width, height) VALUES (?1, ?2, ?3, ?4, ?5)",
                bindings: [.text(asset.hash), .blob(asset.bytes), .text(asset.format), .integer(Int64(asset.width)), .integer(Int64(asset.height))]
            )
        }
    }

    private func replaceAnnotations(_ annotations: [NibAnnotation]) throws {
        try execute("DELETE FROM annotations")
        for annotation in annotations {
            try update(
                """
                INSERT INTO annotations (id, type, data, color, source, z_index, visible, locked, group_id, created_at, modified_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                """,
                bindings: [
                    .text(annotation.id),
                    .text(annotation.kind.storageType),
                    .text(try dataJSON(for: annotation)),
                    .text(annotation.style.color),
                    .text(annotation.source),
                    .integer(Int64(annotation.zIndex)),
                    .integer(annotation.visible ? 1 : 0),
                    .integer(annotation.locked ? 1 : 0),
                    annotation.groupID.map { .integer(Int64($0)) } ?? .null,
                    .integer(Int64(annotation.createdAt.timeIntervalSince1970)),
                    .integer(Int64(annotation.modifiedAt.timeIntervalSince1970))
                ]
            )
        }
    }

    private func tableExists(_ table: String) throws -> Bool {
        try query("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", bindings: [.text(table)]) { statement in
            guard sqlite3_step(statement) == SQLITE_ROW else { return false }
            return sqlite3_column_int64(statement, 0) > 0
        }
    }

    private func rows(_ sql: String) throws -> [[String: SQLiteValue]] {
        try query(sql) { statement in
            var output: [[String: SQLiteValue]] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                var row: [String: SQLiteValue] = [:]
                for index in 0..<sqlite3_column_count(statement) {
                    let name = String(cString: sqlite3_column_name(statement, index))
                    row[name] = SQLiteValue(statement: statement, index: index)
                }
                output.append(row)
            }
            return output
        }
    }

    private func execute(_ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            throw NibDocumentError.sqliteFailure(errorMessage)
        }
    }

    private func update(_ sql: String, bindings: [SQLiteBinding]) throws {
        try query(sql, bindings: bindings) { statement in
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw NibDocumentError.sqliteFailure(errorMessage)
            }
        }
    }

    private func query<T>(_ sql: String, bindings: [SQLiteBinding] = [], body: (OpaquePointer?) throws -> T) throws -> T {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            throw NibDocumentError.sqliteFailure(errorMessage)
        }
        defer { sqlite3_finalize(statement) }
        for (offset, binding) in bindings.enumerated() {
            try binding.bind(to: statement, index: Int32(offset + 1))
        }
        return try body(statement)
    }

    private var errorMessage: String {
        guard let handle else { return "database is closed" }
        return String(cString: sqlite3_errmsg(handle))
    }
}

private enum SQLiteBinding {
    case null
    case integer(Int64)
    case text(String)
    case blob(Data)

    func bind(to statement: OpaquePointer?, index: Int32) throws {
        switch self {
        case .null:
            sqlite3_bind_null(statement, index)
        case .integer(let value):
            sqlite3_bind_int64(statement, index, value)
        case .text(let value):
            sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
        case .blob(let data):
            try data.withUnsafeBytes { buffer in
                guard sqlite3_bind_blob(statement, index, buffer.baseAddress, Int32(buffer.count), sqliteTransient) == SQLITE_OK else {
                    throw NibDocumentError.sqliteFailure("failed to bind blob")
                }
            }
            return
        }
    }
}

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private enum SQLiteValue: Sendable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)

    init(statement: OpaquePointer?, index: Int32) {
        switch sqlite3_column_type(statement, index) {
        case SQLITE_INTEGER:
            self = .integer(sqlite3_column_int64(statement, index))
        case SQLITE_FLOAT:
            self = .real(sqlite3_column_double(statement, index))
        case SQLITE_TEXT:
            self = .text(sqliteText(statement, index) ?? "")
        case SQLITE_BLOB:
            self = .blob(sqliteBlob(statement, index))
        default:
            self = .null
        }
    }

    var string: String? {
        switch self {
        case .text(let value):
            return value
        case .integer(let value):
            return String(value)
        case .real(let value):
            return String(value)
        case .null, .blob:
            return nil
        }
    }

    var data: Data? {
        if case .blob(let value) = self { return value }
        return nil
    }

    var int: Int? {
        switch self {
        case .integer(let value):
            return Int(value)
        case .real(let value):
            return Int(value)
        case .text(let value):
            return Int(value)
        case .null, .blob:
            return nil
        }
    }

    var optionalInt: Int? {
        if case .null = self { return nil }
        return int
    }

    var double: Double? {
        switch self {
        case .integer(let value):
            return Double(value)
        case .real(let value):
            return value
        case .text(let value):
            return Double(value)
        case .null, .blob:
            return nil
        }
    }

    var date: Date? {
        double.map { Date(timeIntervalSince1970: $0) }
    }
}

private extension Dictionary where Key == String, Value == SQLiteValue {
    func firstInt(_ keys: [String]) -> Int? {
        for key in keys {
            if let value = self[key]?.int { return value }
        }
        return nil
    }

    func firstDouble(_ keys: [String]) -> Double? {
        for key in keys {
            if let value = self[key]?.double { return value }
        }
        return nil
    }
}

private struct JSONObject {
    private var raw: [String: Any]

    static func parse(_ string: String) throws -> JSONObject {
        let data = Data(string.utf8)
        let object = try JSONSerialization.jsonObject(with: data)
        return JSONObject(raw: object as? [String: Any] ?? [:])
    }

    func double(_ key: String, default defaultValue: Double = 0) -> Double {
        if let value = raw[key] as? Double { return value }
        if let value = raw[key] as? Int { return Double(value) }
        if let value = raw[key] as? String, let parsed = Double(value) { return parsed }
        return defaultValue
    }

    func optionalDouble(_ key: String) -> Double? {
        guard raw[key] != nil else { return nil }
        return double(key)
    }

    func int(_ key: String) -> Int? {
        if let value = raw[key] as? Int { return value }
        if let value = raw[key] as? Double { return Int(value) }
        if let value = raw[key] as? String { return Int(value) }
        return nil
    }

    func uint32(_ key: String, default defaultValue: UInt32 = 0) -> UInt32 {
        int(key).map(UInt32.init) ?? defaultValue
    }

    func string(_ key: String, default defaultValue: String = "") -> String {
        raw[key] as? String ?? defaultValue
    }

    func bool(_ key: String, default defaultValue: Bool = false) -> Bool {
        if let value = raw[key] as? Bool { return value }
        if let value = raw[key] as? Int { return value != 0 }
        return defaultValue
    }

    func points(_ key: String) -> [NibPoint] {
        guard let values = raw[key] as? [Any] else { return [] }
        return values.compactMap { value in
            if let pair = value as? [Double], pair.count >= 2 {
                return NibPoint(x: pair[0], y: pair[1])
            }
            if let pair = value as? [Any], pair.count >= 2 {
                let x = (pair[0] as? Double) ?? Double(pair[0] as? Int ?? 0)
                let y = (pair[1] as? Double) ?? Double(pair[1] as? Int ?? 0)
                return NibPoint(x: x, y: y)
            }
            guard let object = value as? [String: Any] else { return nil }
            let x = (object["x"] as? Double) ?? Double(object["x"] as? Int ?? 0)
            let y = (object["y"] as? Double) ?? Double(object["y"] as? Int ?? 0)
            return NibPoint(x: x, y: y)
        }
    }
}

private func kind(type: String, data: JSONObject) throws -> NibAnnotationKind {
    switch type {
    case "box", "rectangle":
        return .rectangle(rect(data))
    case "arrow":
        return .arrow(start: start(data), end: end(data))
    case "line":
        return .line(start: start(data), end: end(data))
    case "ellipse":
        return .ellipse(
            center: NibPoint(x: data.double("center_x"), y: data.double("center_y")),
            radiusX: data.double("radius_x"),
            radiusY: data.double("radius_y")
        )
    case "highlight":
        return .highlight(rect(data))
    case "blur":
        return .blur(rect(data))
    case "text":
        return .text(position: point(data), content: data.string("content"))
    case "number":
        return .number(position: point(data), value: data.uint32("value"), radius: data.double("radius", default: 12))
    case "crop":
        return .crop(rect(data))
    case "path":
        return .path(points: data.points("points"))
    case "image":
        return .image(region: rect(data), assetHash: data.string("asset_hash"))
    default:
        throw NibDocumentError.invalidDocument("unknown annotation type \(type)")
    }
}

private func style(type: String, data: JSONObject, color: String) -> NibAnnotationStyle {
    let strokeStyle = NibStrokeStyle(rawValue: data.string("stroke_style", default: "solid"))
    let textAlignment = NibTextAlignment(rawValue: data.string("align", default: "left"))
    let blurIntensity = NibBlurIntensity(rawValue: data.string("intensity", default: "medium"))
    let arrowHead = NibArrowHead(rawValue: data.string("head_style", default: "end"))
    return NibAnnotationStyle(
        color: color,
        opacity: data.optionalDouble("opacity") ?? 1,
        strokeWidth: data.optionalDouble("stroke_width"),
        strokeStyle: strokeStyle,
        fillColor: data.string("fill_color", default: ""),
        filled: data.bool("filled", default: false),
        cornerRadius: data.optionalDouble("corner_radius"),
        arrowHead: type == "arrow" ? arrowHead : nil,
        fontSize: data.optionalDouble("font_size"),
        textAlignment: type == "text" ? textAlignment : nil,
        textBackground: data.string("background", default: ""),
        maxWidth: data.optionalDouble("max_width"),
        blurIntensity: type == "blur" ? blurIntensity : nil
    )
}

private func dataJSON(for annotation: NibAnnotation) throws -> String {
    var object: [String: Any] = [:]
    switch annotation.kind {
    case .rectangle(let rect):
        apply(rect, to: &object)
        object["stroke_width"] = annotation.style.strokeWidth ?? 2
        object["corner_radius"] = annotation.style.cornerRadius ?? 0
        object["filled"] = annotation.style.filled ?? false
        object["stroke_style"] = annotation.style.strokeStyle?.rawValue ?? "solid"
    case .arrow(let start, let end):
        apply(start: start, end: end, to: &object)
        object["stroke_width"] = annotation.style.strokeWidth ?? 2
        object["head_style"] = annotation.style.arrowHead?.rawValue ?? "end"
    case .line(let start, let end):
        apply(start: start, end: end, to: &object)
        object["stroke_width"] = annotation.style.strokeWidth ?? 2
        object["stroke_style"] = annotation.style.strokeStyle?.rawValue ?? "solid"
    case .ellipse(let center, let radiusX, let radiusY):
        object["center_x"] = center.x
        object["center_y"] = center.y
        object["radius_x"] = radiusX
        object["radius_y"] = radiusY
        object["stroke_width"] = annotation.style.strokeWidth ?? 2
        object["filled"] = annotation.style.filled ?? false
    case .highlight(let rect):
        apply(rect, to: &object)
        object["corner_radius"] = annotation.style.cornerRadius ?? 0
    case .blur(let rect):
        apply(rect, to: &object)
        object["intensity"] = annotation.style.blurIntensity?.rawValue ?? "medium"
    case .text(let position, let content):
        apply(position, to: &object)
        object["content"] = content
        object["font_size"] = annotation.style.fontSize ?? 16
        object["align"] = annotation.style.textAlignment?.rawValue ?? "left"
        if let background = annotation.style.textBackground, !background.isEmpty { object["background"] = background }
        if let maxWidth = annotation.style.maxWidth { object["max_width"] = maxWidth }
    case .number(let position, let value, let radius):
        apply(position, to: &object)
        object["value"] = Int(value)
        object["radius"] = radius
    case .crop(let rect):
        apply(rect, to: &object)
    case .path(let points):
        object["points"] = points.map { ["x": $0.x, "y": $0.y] }
        object["stroke_width"] = annotation.style.strokeWidth ?? 2
        object["stroke_style"] = annotation.style.strokeStyle?.rawValue ?? "solid"
    case .image(let region, let assetHash):
        apply(region, to: &object)
        object["asset_hash"] = assetHash
        object["opacity"] = annotation.style.opacity
    }
    if let pageIndex = annotation.anchor.pageIndex { object["pageIndex"] = pageIndex }
    if let timeMs = annotation.anchor.timeMs { object["timeMs"] = timeMs }
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
}

private func rect(_ data: JSONObject) -> NibRect {
    NibRect(x: data.double("x"), y: data.double("y"), width: data.double("width"), height: data.double("height"))
}

private func point(_ data: JSONObject) -> NibPoint {
    NibPoint(x: data.double("x"), y: data.double("y"))
}

private func start(_ data: JSONObject) -> NibPoint {
    NibPoint(x: data.double("start_x"), y: data.double("start_y"))
}

private func end(_ data: JSONObject) -> NibPoint {
    NibPoint(x: data.double("end_x"), y: data.double("end_y"))
}

private func apply(_ rect: NibRect, to object: inout [String: Any]) {
    object["x"] = rect.x
    object["y"] = rect.y
    object["width"] = rect.width
    object["height"] = rect.height
}

private func apply(_ point: NibPoint, to object: inout [String: Any]) {
    object["x"] = point.x
    object["y"] = point.y
}

private func apply(start: NibPoint, end: NibPoint, to object: inout [String: Any]) {
    object["start_x"] = start.x
    object["start_y"] = start.y
    object["end_x"] = end.x
    object["end_y"] = end.y
}

private func sqliteText(_ statement: OpaquePointer?, _ index: Int32) -> String? {
    guard let value = sqlite3_column_text(statement, index) else { return nil }
    return String(cString: value)
}

private func sqliteBlob(_ statement: OpaquePointer?, _ index: Int32) -> Data {
    let count = Int(sqlite3_column_bytes(statement, index))
    guard count > 0, let value = sqlite3_column_blob(statement, index) else { return Data() }
    return Data(bytes: value, count: count)
}

private func sqliteDate(_ statement: OpaquePointer?, _ index: Int32) -> Date {
    Date(timeIntervalSince1970: TimeInterval(sqlite3_column_int64(statement, index)))
}

private func sqliteNullableInt(_ statement: OpaquePointer?, _ index: Int32) -> Int? {
    sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(statement, index))
}

private func sqliteNullableDate(_ statement: OpaquePointer?, _ index: Int32) -> Date? {
    sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : sqliteDate(statement, index)
}
#endif
