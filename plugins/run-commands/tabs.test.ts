import { describe, expect, it } from "vitest";
import { browserTabFor, withTab, type PanelTab } from "./tabs.js";

const infoTab: PanelTab = { id: "a", kind: "thread-info" };
const tab = browserTabFor({
  pluginId: "run-commands",
  environmentId: "env_1",
  url: "http://localhost:3000/",
  title: "Dev server",
});

describe("browserTabFor", () => {
  it("builds the browser tab BB's schema wants, with an id derived from the address", () => {
    expect(tab).toEqual({
      id: "run-commands-web-localhost-3000",
      kind: "browser",
      environmentId: "env_1",
      title: "Dev server",
      url: "http://localhost:3000/",
    });
  });
});

describe("withTab", () => {
  it("adds the tab after the ones already there", () => {
    expect(withTab([infoTab], tab)).toEqual([infoTab, tab]);
  });

  it("has nothing to write when the tab is already open", () => {
    expect(withTab([infoTab, tab], tab)).toBeNull();
  });

  it("keeps tab kinds it has never heard of, field for field", () => {
    const strange: PanelTab = { id: "x", kind: "from-the-future", payload: { deep: [1, 2] } };
    expect(withTab([strange], tab)?.[0]).toBe(strange);
  });
});
