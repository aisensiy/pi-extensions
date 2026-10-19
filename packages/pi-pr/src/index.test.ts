import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piPr from "./index.js";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const openPrJson = JSON.stringify({ number: 7, url: "https://example.com/pr/7" });

function ghResult(stdout: string): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * Drives the real extension callbacks (registered `/pr` command, `session_start`,
 * `session_shutdown`) while faking only the external `gh` exec: `pr view --web`
 * resolves immediately, each `pr view --json` stays pending until the test
 * resolves it through `jsonQueries`. The abort signal handed to each `gh` call
 * is recorded so tests can assert which in-flight refresh is still cancellable.
 */
function createHarness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const jsonQueries: Deferred<ExecResult>[] = [];
  const execCalls: { args: string[]; opts: { signal?: AbortSignal } }[] = [];

  const flags = new Map<string, string>();
  const exec = vi.fn((cmd: string, args: string[], opts: { signal?: AbortSignal }) => {
    void cmd;
    if (args.includes("--web")) {
      return Promise.resolve(ghResult(""));
    }
    execCalls.push({ args, opts });
    const query = deferred<ExecResult>();
    jsonQueries.push(query);
    return query.promise;
  });

  const pi = {
    registerFlag: (name: string, opts: { default?: string }) => {
      if (opts.default !== undefined) {
        flags.set(name, opts.default);
      }
    },
    getFlag: (name: string) => flags.get(name),
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
      handlers.set(event, handler);
    },
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => {
      commands.set(name, def);
    },
    exec,
  } as unknown as ExtensionAPI;

  piPr(pi);

  const makeCtx = () => {
    const setStatus = vi.fn();
    const ctx = {
      ui: {
        setStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    return { ctx, setStatus };
  };

  return { handlers, commands, jsonQueries, execCalls, makeCtx };
}

describe("piPr refresh lifecycle", () => {
  it("cancels a pending refresh on shutdown and never touches the stale ctx", async () => {
    const h = createHarness();
    const { ctx, setStatus } = h.makeCtx();
    const command = h.commands.get("pr");
    if (!command) {
      throw new Error("pr command was not registered");
    }

    const outcome = command.handler("", ctx).then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(h.jsonQueries.length).toBe(1));

    h.handlers.get("session_shutdown")?.({}, ctx);
    expect(h.execCalls[0].opts.signal?.aborted).toBe(true);

    h.jsonQueries[0].resolve(ghResult(openPrJson));
    await flush();

    expect(await outcome).toBe("resolved");
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does not let an old cancelled refresh clobber a newer pending one", async () => {
    const h = createHarness();
    const first = h.makeCtx();
    const command = h.commands.get("pr");
    if (!command) {
      throw new Error("pr command was not registered");
    }

    const oldOutcome = command.handler("", first.ctx).then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(h.jsonQueries.length).toBe(1));

    h.handlers.get("session_shutdown")?.({}, first.ctx);

    const second = h.makeCtx();
    h.handlers.get("session_start")?.({}, second.ctx);
    await vi.waitFor(() => expect(h.jsonQueries.length).toBe(2));

    h.jsonQueries[0].resolve(ghResult(openPrJson));
    await flush();

    h.handlers.get("session_shutdown")?.({}, second.ctx);
    h.jsonQueries[1].resolve(ghResult(openPrJson));
    await flush();

    expect(await oldOutcome).toBe("resolved");
    expect(first.setStatus).not.toHaveBeenCalled();
    expect(second.setStatus).not.toHaveBeenCalled();
    expect(h.execCalls[1].opts.signal?.aborted).toBe(true);
  });

  it("renders the PR status into the footer on a normal refresh", async () => {
    const h = createHarness();
    const { ctx, setStatus } = h.makeCtx();

    h.handlers.get("session_start")?.({}, ctx);
    await vi.waitFor(() => expect(h.jsonQueries.length).toBe(1));

    h.jsonQueries[0].resolve(ghResult(openPrJson));
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));
    expect(setStatus).toHaveBeenCalledWith("pi-pr", expect.stringContaining("#7"));

    h.handlers.get("session_shutdown")?.({}, ctx);
  });
});
