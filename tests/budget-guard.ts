/**
 * Makes every sandbox invocation in a test file prove its call budget: the runtime host's route,
 * hook and admin entry points are wrapped with eventual-capacity's harness, so any route, cron
 * task or admin page that makes more than 10 bridge calls fails the test that triggered it, with
 * the list of calls. `maxCalls()` reports the highest count seen per label.
 */
import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { expectWithinBudget, withBudget } from "@vermeulen.solutions/eventual-capacity/testing";

const highest: Record<string, number> = {};

export function guardBudget(host: PluginRuntimeTestHost): void {
  const budget = withBudget(host);
  const wrap = (owner: any, method: string, label: (args: any[]) => string) => {
    const original = owner[method].bind(owner);
    owner[method] = async (...args: any[]) => {
      const name = label(args);
      const result = await budget.measure(name, () => original(...args));
      expectWithinBudget(result);
      for (const usage of result.invocations) highest[name] = Math.max(highest[name] ?? 0, usage.calls.length);
      return result.value;
    };
  };
  wrap(host.actions.routes, "request", ([route]) => `route ${route}`);
  wrap(host.transport, "invokeRoute", ([route]) => `route ${route}`);
  wrap(host.transport, "invokeHook", ([hook, event]) => `hook ${hook}${event?.name ? ` ${event.name}` : ""}`);
  for (const method of ["loadPage", "act", "submit", "loadEditorPanel", "actEditorPanel", "submitEditorPanel"]) {
    wrap(host.admin, method, ([first, second]) => `admin ${method} ${typeof first === "string" ? first : ""}${method === "act" || method === "submit" ? ` ${second}` : ""}`);
  }
}

export function maxCalls(): Record<string, number> {
  return { ...highest };
}
