import { describe, expect, it } from "vitest";
import { isTopic } from "../src/hub.ts";

describe("WebSocket-témák", () => {
  it("a web minden megállótábla-témája feliratkozható (módokkal és összevonással is)", () => {
    // ezt küldi a figyelő, a megállófiók, a kioszk és az ingázó-kártya (lásd web `boardKey`)
    expect(isTopic("stop:1:005511387@tram,bus,coach,rail~all")).toBe(true);
    expect(isTopic("stop:SP84@tram,bus~mvk")).toBe(true);
    expect(isTopic("stop:hkir:hkir_213961_2@coach~coach")).toBe(true);
    expect(isTopic("stop:SP84@tram,bus,coach~off")).toBe(true);
    // a régi alakok is maradnak (iOS, régebbi web)
    expect(isTopic("stop:SP85")).toBe(true);
    expect(isTopic("stop:1:005511387@rail")).toBe(true);
    expect(isTopic("vehicles@tram,bus,coach,rail")).toBe(true);
    expect(isTopic("trip:1:35051212")).toBe(true);
  });

  it("ismeretlen összevonás, mód vagy szemét nem", () => {
    expect(isTopic("stop:SP84@tram~xyz")).toBe(false);
    expect(isTopic("stop:SP84@plane")).toBe(false);
    expect(isTopic("stop:SP84 OR 1=1")).toBe(false);
    expect(isTopic("admin")).toBe(false);
  });
});
