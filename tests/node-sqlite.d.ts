// Tests typecheck against the worker's types, which have no Node. The D1 stand-in in
// pipeline.test.ts needs only this much of node:sqlite (Node 22.5+).
declare module 'node:sqlite' {
  type Value = null | number | bigint | string | Uint8Array;
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): {
      get(...params: Value[]): unknown;
      all(...params: Value[]): unknown[];
      run(...params: Value[]): { changes: number | bigint };
    };
  }
}
