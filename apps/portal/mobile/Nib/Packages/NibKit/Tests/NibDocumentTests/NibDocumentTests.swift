import Foundation
import NibDocument
import Testing

#if canImport(CryptoKit)
import CryptoKit
#endif

#if canImport(SQLite3)
import SQLite3
#endif

@Suite("Immutable .nib document primitives")
struct NibDocumentTests {
    @Test("Opening a real .nib SQLite schema decodes document primitives")
    func opensRepresentativeNibSchema() throws {
        let source = try makeRepresentativeNibFile()

        let document = try NibDocumentStore.open(at: source)

        #expect(document.schemaVersion == 2)
        #expect(document.fileID == "file_source")
        #expect(document.image.format == "png")
        #expect(document.image.width == 640)
        #expect(document.image.height == 480)
        #expect(document.metadata["requestID"] == "request_1")
        #expect(document.assets.map(\.hash) == ["asset_hash_1"])
        #expect(document.session?.guiPID == 42)
        #expect(document.messages.map(\.content) == ["Ready"])
        #expect(document.annotations.map { $0.kind.storageType } == [
            "rectangle",
            "arrow",
            "line",
            "ellipse",
            "highlight",
            "blur",
            "text",
            "number",
            "crop",
            "path",
            "image"
        ])
        #expect(document.annotations[0].anchor.pageIndex == 2)
        #expect(document.annotations[0].anchor.timeMs == 1_250)
        #expect(document.annotations[0].visible)
        #expect(!document.annotations[0].locked)
        #expect(document.annotations[0].groupID == 7)

        guard case .image(_, let assetHash) = document.annotations.last?.kind else {
            Issue.record("expected image annotation")
            return
        }
        #expect(assetHash == "asset_hash_1")
    }

    @Test("Export writes a distinct derivative and never mutates the opened source")
    func exportPreservesSourceBytesAndRecordsLineage() throws {
        let source = try makeRepresentativeNibFile()
        let before = try fileDigest(source)
        var state = NibEditorState(document: try NibDocumentStore.open(at: source))
        let added = NibAnnotation(
            id: "a12",
            kind: .text(position: NibPoint(x: 100, y: 120), content: "Derivative note"),
            anchor: NibAnnotationAnchor(pageIndex: 1, timeMs: 2_500),
            style: NibAnnotationStyle(color: "#ff0000", fontSize: 18, textAlignment: .left)
        )
        state = NibEditorReducer.reduce(state, .addAnnotation(added))
        let destination = source.deletingLastPathComponent().appendingPathComponent("derived.nib")

        try NibDocumentStore.export(state.document, to: destination)

        #expect(FileManager.default.fileExists(atPath: destination.path))
        #expect(try fileDigest(source) == before)

        let sourceAfter = try NibDocumentStore.open(at: source)
        let derivative = try NibDocumentStore.open(at: destination)
        let derivativeNote = derivative.annotations.first { $0.id == "a12" }
        #expect(sourceAfter.annotations.count == 11)
        #expect(derivative.annotations.count == 12)
        #expect(derivative.metadata["derivedFromFileID"] == "file_source")
        #expect(derivativeNote?.anchor.pageIndex == 1)
        #expect(derivativeNote?.anchor.timeMs == 2_500)
    }

    @Test("Editor reducer returns immutable states with undo and redo")
    func reducerUndoRedoIsImmutable() throws {
        let source = try makeRepresentativeNibFile()
        let initialDocument = try NibDocumentStore.open(at: source)
        let annotation = NibAnnotation(
            id: "local_1",
            kind: .rectangle(NibRect(x: 1, y: 2, width: 3, height: 4))
        )

        let initial = NibEditorState(document: initialDocument)
        let added = NibEditorReducer.reduce(initial, .addAnnotation(annotation))
        let hidden = NibEditorReducer.reduce(added, .setVisibility(ids: ["local_1"], visible: false))
        let undone = NibEditorReducer.reduce(hidden, .undo)
        let redone = NibEditorReducer.reduce(undone, .redo)

        #expect(initial.document.annotations.count == 11)
        #expect(added.document.annotations.count == 12)
        #expect(hidden.document.annotations.last?.visible == false)
        #expect(undone.document.annotations.last?.visible == true)
        #expect(redone.document.annotations.last?.visible == false)
        #expect(!initial.document.annotations.contains { $0.id == "local_1" })
    }

    @Test("Reducer supports selection, grouping, lock, and delete without deleting locked annotations")
    func reducerGroupingLockAndDelete() throws {
        let source = try makeRepresentativeNibFile()
        let document = try NibDocumentStore.open(at: source)
        var state = NibEditorState(document: document)

        state = NibEditorReducer.reduce(state, .select(["a1", "a2"]))
        state = NibEditorReducer.reduce(state, .group(["a1", "a2"]))
        state = NibEditorReducer.reduce(state, .setLock(ids: ["a1"], locked: true))
        state = NibEditorReducer.reduce(state, .deleteAnnotations(["a1", "a2"]))

        #expect(state.selectedAnnotationIDs.isEmpty)
        #expect(state.document.annotations.contains { $0.id == "a1" })
        #expect(!state.document.annotations.contains { $0.id == "a2" })
        #expect(state.document.annotations.first { $0.id == "a1" }?.locked == true)
        #expect(state.undoDocuments.count == 3)
    }
}

private func makeRepresentativeNibFile() throws -> URL {
    #if canImport(SQLite3)
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("NibDocumentTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("source.nib")

    var db: OpaquePointer?
    guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
        throw FixtureError.sqlite("open failed")
    }
    defer { sqlite3_close(db) }

    try execute(db, """
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version VALUES (2);

    CREATE TABLE image (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data BLOB NOT NULL,
        format TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        original_path TEXT
    );

    CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data JSON NOT NULL,
        color TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        z_index INTEGER DEFAULT 0,
        visible INTEGER DEFAULT 1,
        locked INTEGER DEFAULT 0,
        group_id INTEGER,
        created_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL
    );

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE session (id INTEGER PRIMARY KEY CHECK (id = 1), gui_pid INTEGER, opened_at INTEGER, last_activity INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'agent', read INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE assets (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL, format TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL);
    """)

    try execute(db, "INSERT INTO image (id, data, format, width, height, imported_at, original_path) VALUES (1, X'89504E47', 'png', 640, 480, 1800000000, '/tmp/source.png')")
    try execute(db, "INSERT INTO metadata (key, value) VALUES ('fileID', 'file_source'), ('requestID', 'request_1')")
    try execute(db, "INSERT INTO session (id, gui_pid, opened_at, last_activity) VALUES (1, 42, 1800000001, 1800000002)")
    try execute(db, "INSERT INTO messages (content, source, read, created_at) VALUES ('Ready', 'agent', 0, 1800000003)")
    try execute(db, "INSERT INTO assets (hash, bytes, format, width, height) VALUES ('asset_hash_1', X'010203', 'png', 80, 60)")

    try insertAnnotation(db, id: "a1", type: "rectangle", data: [
        "x": 10, "y": 20, "width": 30, "height": 40, "stroke_width": 2, "corner_radius": 4,
        "filled": false, "stroke_style": "solid", "pageIndex": 2, "timeMs": 1250
    ], groupID: 7)
    try insertAnnotation(db, id: "a2", type: "arrow", data: ["start_x": 1, "start_y": 2, "end_x": 3, "end_y": 4, "stroke_width": 2, "head_style": "end"])
    try insertAnnotation(db, id: "a3", type: "line", data: ["start_x": 5, "start_y": 6, "end_x": 7, "end_y": 8, "stroke_width": 1, "stroke_style": "dashed"])
    try insertAnnotation(db, id: "a4", type: "ellipse", data: ["center_x": 20, "center_y": 21, "radius_x": 8, "radius_y": 9, "stroke_width": 2, "filled": true])
    try insertAnnotation(db, id: "a5", type: "highlight", data: ["x": 2, "y": 3, "width": 4, "height": 5, "corner_radius": 1])
    try insertAnnotation(db, id: "a6", type: "blur", data: ["x": 6, "y": 7, "width": 8, "height": 9, "intensity": "high"])
    try insertAnnotation(db, id: "a7", type: "text", data: ["x": 12, "y": 13, "content": "Hello", "font_size": 16, "align": "left", "background": "#ffffff", "max_width": 120])
    try insertAnnotation(db, id: "a8", type: "number", data: ["x": 14, "y": 15, "value": 3, "radius": 10])
    try insertAnnotation(db, id: "a9", type: "crop", data: ["x": 16, "y": 17, "width": 18, "height": 19])
    try insertAnnotation(db, id: "a10", type: "path", data: ["points": [["x": 1, "y": 1], ["x": 2, "y": 3]], "stroke_width": 3, "stroke_style": "solid"])
    try insertAnnotation(db, id: "a11", type: "image", data: ["x": 22, "y": 23, "width": 24, "height": 25, "asset_hash": "asset_hash_1", "opacity": 0.75])

    return url
    #else
    throw NibDocumentError.sqliteUnavailable
    #endif
}

#if canImport(SQLite3)
private func insertAnnotation(_ db: OpaquePointer?, id: String, type: String, data: [String: Any], groupID: Int? = nil) throws {
    let json = try String(decoding: JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]), as: UTF8.self)
    let group = groupID.map(String.init) ?? "NULL"
    try execute(db, """
    INSERT INTO annotations (id, type, data, color, source, z_index, visible, locked, group_id, created_at, modified_at)
    VALUES ('\(id)', '\(type)', '\(json.replacingOccurrences(of: "'", with: "''"))', '#0a84ff', 'human', \(numericSuffix(id)), 1, 0, \(group), 1800000004, 1800000005)
    """)
}

private func numericSuffix(_ value: String) -> Int {
    Int(value.drop { !$0.isNumber }) ?? 0
}

private func execute(_ db: OpaquePointer?, _ sql: String) throws {
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
        let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite failure"
        throw FixtureError.sqlite(message)
    }
}
#endif

private func fileDigest(_ url: URL) throws -> String {
    let data = try Data(contentsOf: url)
    #if canImport(CryptoKit)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    #else
    return data.base64EncodedString()
    #endif
}

private enum FixtureError: Error {
    case sqlite(String)
}
