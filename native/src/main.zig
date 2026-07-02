const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");
const native_policy = @import("allowed_origins.zig");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const app_permissions = [_][]const u8{zero_native.security.permission_window};

const App = struct {
    env_map: *std.process.Environ.Map,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "prtl",
            .source = zero_native.frontend.productionSource(.{ .dist = "../dist/client" }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return zero_native.frontend.sourceFromEnv(self.env_map, .{
            .dist = "../dist/client",
            .entry = "index.html",
        });
    }
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map };
    try runner.runWithOptions(app.app(), .{
        .app_name = "prtl",
        .window_title = "prtl",
        .bundle_id = "dev.douglance.prtl",
        .icon_path = "",
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{ .allowed_origins = &native_policy.allowed_origins },
        },
        .js_window_api = true,
    }, init);
}

test "app name is configured" {
    try std.testing.expectEqualStrings("prtl", "prtl");
}
