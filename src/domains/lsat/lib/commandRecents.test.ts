import { describe, expect, it } from "vitest";

import {
  getCommandRecents,
  pushCommandRecent,
  routeCommandLabel,
} from "./commandRecents";
import { setJSON, STORAGE_KEYS } from "./storage";

describe("commandRecents", () => {
  it("canonicalizes the /notebook alias to home so recents do not duplicate LSAT Library", () => {
    setJSON(STORAGE_KEYS.commandRecents, ["/notebook", "/dashboard", "/"]);

    expect(getCommandRecents()).toEqual(["/", "/dashboard"]);

    pushCommandRecent("/notebook");

    expect(getCommandRecents()).toEqual(["/", "/dashboard"]);
    expect(routeCommandLabel("/notebook")).toBe("LSAT Library");
  });
});
