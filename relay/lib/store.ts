import { AsyncLocalStorage } from "node:async_hooks";
import type { RelayState } from "../src/state";

/**
 * Per-request access to the single RelayState Durable Object and the execution context. Workers forbid using an
 * I/O object (such as a DO stub) created by one request from another request, so both live in AsyncLocalStorage
 * and the worker wraps every handler in runWithState().
 */
type Stub = DurableObjectStub<RelayState>;
interface Ctx {
  stub: Stub;
  waitUntil?: (p: Promise<unknown>) => void;
}
const als = new AsyncLocalStorage<Ctx>();

export function runWithState<T>(stub: Stub, waitUntil: ((p: Promise<unknown>) => void) | undefined, fn: () => Promise<T>): Promise<T> {
  return als.run({ stub, waitUntil }, fn);
}
export function state(): Stub {
  const s = als.getStore();
  if (!s) throw new Error("RelayState not bound for this request");
  return s.stub;
}
/** Keep the isolate alive until `p` settles (no-op outside Workers). */
export function waitUntil(p: Promise<unknown>): void {
  als.getStore()?.waitUntil?.(p);
}
