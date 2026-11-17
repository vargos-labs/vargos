import { describe, expect, it } from "vitest";
import {
  availableActions,
  definitionFor,
  relatedResources,
  type ResourceAction,
} from "../model";

describe("spatial resource projection", () => {
  it("allows local navigation but gates method actions by registration and transport independently", () => {
    const actions: ResourceAction[] = [
      {
        id: "inspect",
        label: "Inspect",
        command: "navigate",
        resourceId: "channel:one",
      },
      {
        id: "restart",
        label: "Restart",
        command: "method",
        method: "channel.restart",
        params: { id: "one" },
      },
    ];
    expect(
      availableActions(actions, [], new Set())[0].disabledReason,
    ).toBeUndefined();
    expect(
      availableActions(actions, [], new Set(["channel.restart"]))[1]
        .disabledReason,
    ).toBe("Method is not registered");
    expect(
      availableActions(actions, [{ name: "channel.restart" }], new Set())[1]
        .disabledReason,
    ).toContain("web connection");
    expect(
      availableActions(
        actions,
        [{ name: "channel.restart" }],
        new Set(["channel.restart"]),
      )[1].disabledReason,
    ).toBeUndefined();
    expect(actions[1].disabledReason).toBeUndefined();
    expect(availableActions(actions, [{ name: "channel.restart" }], new Set(["channel.restart"]))[1]).toMatchObject({
      method: "channel.restart", params: { id: "one" },
    });
  });
  it("falls back to an inspector for new kinds, including prototype property names", () => {
    expect(definitionFor("new-speech-service").template).toBe("inspector");
    expect(definitionFor("constructor").template).toBe("inspector");
    expect(definitionFor("session").template).toBe("thread");
  });
  it("presents relationships in the correct direction from either object", () => {
    const edges = [
      {
        from: "session",
        to: "memory",
        label: "produced",
        inverseLabel: "saved from",
      },
    ];
    expect(relatedResources("session", edges)).toEqual([
      { resourceId: "memory", label: "produced" },
    ]);
    expect(relatedResources("memory", edges)).toEqual([
      { resourceId: "session", label: "saved from" },
    ]);
    expect(relatedResources("other", edges)).toEqual([]);
  });
});
