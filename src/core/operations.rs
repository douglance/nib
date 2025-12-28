//! Annotation operations (CRUD and undo/redo support)

use super::types::*;

/// Represents a reversible operation for undo/redo
#[derive(Debug, Clone)]
pub enum Operation {
    /// Add an annotation
    AddAnnotation {
        annotation: Annotation,
    },

    /// Remove an annotation
    RemoveAnnotation {
        annotation: Annotation,
    },

    /// Modify an annotation (stores before state)
    ModifyAnnotation {
        id: AnnotationId,
        before: Annotation,
        after: Annotation,
    },

    /// Move annotation to new position
    MoveAnnotation {
        id: AnnotationId,
        delta_x: f64,
        delta_y: f64,
    },

    /// Change z-order
    ReorderAnnotation {
        id: AnnotationId,
        old_z: i32,
        new_z: i32,
    },

    /// Batch of operations (for grouping)
    Batch(Vec<Operation>),
}

impl Operation {
    /// Returns the inverse operation for undo
    pub fn inverse(&self) -> Operation {
        match self {
            Operation::AddAnnotation { annotation } => Operation::RemoveAnnotation {
                annotation: annotation.clone(),
            },
            Operation::RemoveAnnotation { annotation } => Operation::AddAnnotation {
                annotation: annotation.clone(),
            },
            Operation::ModifyAnnotation { id, before, after } => Operation::ModifyAnnotation {
                id: *id,
                before: after.clone(),
                after: before.clone(),
            },
            Operation::MoveAnnotation { id, delta_x, delta_y } => Operation::MoveAnnotation {
                id: *id,
                delta_x: -*delta_x,
                delta_y: -*delta_y,
            },
            Operation::ReorderAnnotation { id, old_z, new_z } => Operation::ReorderAnnotation {
                id: *id,
                old_z: *new_z,
                new_z: *old_z,
            },
            Operation::Batch(ops) => {
                Operation::Batch(ops.iter().rev().map(|op| op.inverse()).collect())
            }
        }
    }
}

/// Undo/redo history manager
#[derive(Debug, Default)]
pub struct History {
    undo_stack: Vec<Operation>,
    redo_stack: Vec<Operation>,
    max_history: usize,
}

impl History {
    pub fn new(max_history: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_history,
        }
    }

    /// Record an operation (clears redo stack)
    pub fn record(&mut self, operation: Operation) {
        self.undo_stack.push(operation);
        self.redo_stack.clear();

        // Trim history if too long
        while self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }
    }

    /// Pop from undo stack, push inverse to redo stack
    pub fn undo(&mut self) -> Option<Operation> {
        if let Some(op) = self.undo_stack.pop() {
            let inverse = op.inverse();
            self.redo_stack.push(op);
            Some(inverse)
        } else {
            None
        }
    }

    /// Pop from redo stack, push inverse to undo stack
    pub fn redo(&mut self) -> Option<Operation> {
        if let Some(op) = self.redo_stack.pop() {
            let inverse = op.inverse();
            self.undo_stack.push(op);
            Some(inverse)
        } else {
            None
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }
}
