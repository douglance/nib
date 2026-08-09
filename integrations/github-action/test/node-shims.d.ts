declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};

declare class Buffer extends Uint8Array {
  static from(input: string | ArrayBuffer | ArrayBufferView): Buffer;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
  };
  export default assert;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
}
