# prtl native shell

This directory contains the optional zero-native shell for prtl.

Use the root package scripts:

```sh
npm run native:manifest
npm run native:doctor
npm run native:build
npm run native:run
```

`native:manifest` writes the generated `native/app.zon` and
`native/src/allowed_origins.zig` files from the current portal/project state.
Those generated files are intentionally ignored because local project ports and
registered website origins are machine-specific.

zero-native 0.2.x currently requires Zig 0.16.0 or newer.
