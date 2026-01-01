//! SQLite index for search
//!
//! Provides fast search over captured images by:
//! - File path
//! - Capture date
//! - Tags
//! - Annotation content

use crate::{database_path, StorageResult};
use nib_core::StorageError;
use rusqlite::{params, Connection};

/// Image entry in the index
#[derive(Debug, Clone)]
pub struct ImageEntry {
    pub id: i64,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub created_at: i64,
    pub modified_at: i64,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub annotation_count: usize,
}

/// Search index manager
pub struct Index {
    conn: Connection,
}

impl Index {
    /// Open or create the index database
    pub fn open() -> StorageResult<Self> {
        let db_path = database_path();

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&db_path)?;
        let index = Self { conn };
        index.init_schema()?;

        Ok(index)
    }

    /// Initialize database schema
    fn init_schema(&self) -> StorageResult<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL UNIQUE,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                modified_at INTEGER NOT NULL,
                title TEXT
            );

            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS image_tags (
                image_id INTEGER REFERENCES images(id) ON DELETE CASCADE,
                tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (image_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS annotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER REFERENCES images(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                label TEXT,
                content TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_images_path ON images(path);
            CREATE INDEX IF NOT EXISTS idx_annotations_label ON annotations(label);
            "#,
        )?;

        Ok(())
    }

    /// Add or update an image in the index
    pub fn upsert_image(&self, entry: &ImageEntry) -> StorageResult<i64> {
        self.conn.execute(
            r#"
            INSERT INTO images (path, width, height, created_at, modified_at, title)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(path) DO UPDATE SET
                width = excluded.width,
                height = excluded.height,
                modified_at = excluded.modified_at,
                title = excluded.title
            "#,
            params![
                entry.path,
                entry.width,
                entry.height,
                entry.created_at,
                entry.modified_at,
                entry.title
            ],
        )?;

        Ok(self.conn.last_insert_rowid())
    }

    /// Remove an image from the index
    pub fn remove_image(&self, path: &str) -> StorageResult<()> {
        self.conn
            .execute("DELETE FROM images WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Search images by various criteria
    pub fn search(&self, query: &SearchQuery) -> StorageResult<Vec<ImageEntry>> {
        let mut sql = String::from(
            r#"
            SELECT i.id, i.path, i.width, i.height, i.created_at, i.modified_at, i.title,
                   COUNT(a.id) as annotation_count
            FROM images i
            LEFT JOIN annotations a ON i.id = a.image_id
            WHERE 1=1
            "#,
        );

        if query.title_contains.is_some() {
            sql.push_str(" AND i.title LIKE '%' || ?1 || '%'");
        }

        sql.push_str(" GROUP BY i.id ORDER BY i.created_at DESC");

        if let Some(limit) = query.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        }

        let mut stmt = self.conn.prepare(&sql)?;

        let entries = if let Some(ref title) = query.title_contains {
            stmt.query_map(params![title], Self::map_row)?
        } else {
            stmt.query_map([], Self::map_row)?
        };

        entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Database(e.to_string()))
    }

    /// List recent images
    pub fn list_recent(&self, limit: usize) -> StorageResult<Vec<ImageEntry>> {
        self.search(&SearchQuery {
            limit: Some(limit),
            ..Default::default()
        })
    }

    fn map_row(row: &rusqlite::Row) -> rusqlite::Result<ImageEntry> {
        Ok(ImageEntry {
            id: row.get(0)?,
            path: row.get(1)?,
            width: row.get(2)?,
            height: row.get(3)?,
            created_at: row.get(4)?,
            modified_at: row.get(5)?,
            title: row.get(6)?,
            tags: Vec::new(), // TODO: Join tags
            annotation_count: row.get(7)?,
        })
    }
}

/// Search query parameters
#[derive(Debug, Default)]
pub struct SearchQuery {
    pub title_contains: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<usize>,
}
