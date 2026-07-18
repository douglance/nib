//! Tool manager for registering and dispatching to tools

use super::{Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};
use std::collections::HashMap;

/// Manages tool instances and dispatches events
pub struct ToolManager {
    tools: HashMap<ToolId, Box<dyn Tool>>,
    active_tool_id: ToolId,
}

impl ToolManager {
    /// Create a new empty tool manager
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            active_tool_id: ToolId::Select,
        }
    }

    /// Create a new tool manager with all built-in tools registered
    pub fn with_all_tools() -> Self {
        let mut manager = Self::new();

        // Register all built-in tools
        manager.register(Box::new(super::SelectTool::new()));
        manager.register(Box::new(super::ArrowTool::new()));
        manager.register(Box::new(super::RectangleTool::new()));
        manager.register(Box::new(super::EllipseTool::new()));
        manager.register(Box::new(super::LineTool::new()));
        manager.register(Box::new(super::TextTool::new()));
        manager.register(Box::new(super::NumberTool::new()));
        manager.register(Box::new(super::HighlightTool::new()));
        manager.register(Box::new(super::BlurTool::new()));
        manager.register(Box::new(super::CropTool::new()));
        manager.register(Box::new(super::PencilTool::new()));
        manager.register(Box::new(super::EraserTool::new()));
        manager.register(Box::new(super::StickyTool::new()));
        manager.register(Box::new(super::ImageTool::new()));

        manager
    }

    /// Register a tool
    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.id(), tool);
    }

    /// Get the currently active tool
    pub fn active_tool(&self) -> Option<&dyn Tool> {
        self.tools.get(&self.active_tool_id).map(|t| t.as_ref())
    }

    /// Get the currently active tool mutably
    pub fn active_tool_mut(&mut self) -> Option<&mut (dyn Tool + '_)> {
        match self.tools.get_mut(&self.active_tool_id) {
            Some(tool) => Some(&mut **tool),
            None => None,
        }
    }

    /// Get the active tool ID
    pub fn active_tool_id(&self) -> ToolId {
        self.active_tool_id
    }

    /// Set the active tool, handling activation/deactivation events
    /// Returns any result from deactivating the old tool (e.g., pending text)
    pub fn set_active_tool(&mut self, id: ToolId, ctx: &ToolContext) -> Option<ToolResult> {
        if id != self.active_tool_id {
            // Deactivate old tool and capture any result
            let deactivation_result =
                if let Some(old_tool) = self.tools.get_mut(&self.active_tool_id) {
                    let result = old_tool.handle_event(ToolEvent::Deactivated, ctx);
                    match result {
                        ToolResult::Ignored | ToolResult::Handled => None,
                        other => Some(other),
                    }
                } else {
                    None
                };

            self.active_tool_id = id;

            // Activate new tool
            if let Some(new_tool) = self.tools.get_mut(&id) {
                let _ = new_tool.handle_event(ToolEvent::Activated, ctx);
            }

            return deactivation_result;
        }
        None
    }

    /// Dispatch an event to the active tool
    pub fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        if let Some(tool) = self.tools.get_mut(&self.active_tool_id) {
            tool.handle_event(event, ctx)
        } else {
            ToolResult::Ignored
        }
    }

    /// Get preview from the active tool
    pub fn preview(&self, ctx: &ToolContext) -> ToolPreview {
        if let Some(tool) = self.tools.get(&self.active_tool_id) {
            tool.preview(ctx)
        } else {
            ToolPreview::None
        }
    }

    /// Get a specific tool by ID
    pub fn get_tool(&self, id: ToolId) -> Option<&dyn Tool> {
        self.tools.get(&id).map(|t| t.as_ref())
    }

    /// Get a specific tool mutably by ID
    pub fn get_tool_mut(&mut self, id: ToolId) -> Option<&mut (dyn Tool + '_)> {
        match self.tools.get_mut(&id) {
            Some(tool) => Some(&mut **tool),
            None => None,
        }
    }

    /// Get a specific tool with downcasting
    pub fn get_tool_as<T: Tool + 'static>(&self, id: ToolId) -> Option<&T> {
        self.tools.get(&id)?.as_any().downcast_ref::<T>()
    }

    /// Get a specific tool mutably with downcasting
    pub fn get_tool_as_mut<T: Tool + 'static>(&mut self, id: ToolId) -> Option<&mut T> {
        self.tools.get_mut(&id)?.as_any_mut().downcast_mut::<T>()
    }

    /// Check if a tool is registered
    pub fn has_tool(&self, id: ToolId) -> bool {
        self.tools.contains_key(&id)
    }

    /// Get all registered tool IDs
    pub fn registered_tools(&self) -> impl Iterator<Item = ToolId> + '_ {
        self.tools.keys().copied()
    }
}

impl Default for ToolManager {
    fn default() -> Self {
        Self::with_all_tools()
    }
}
