import { describe, expect, it } from "vitest";

import { isCompatibleSchemaVersion } from "@/types/validate";

describe("isCompatibleSchemaVersion", () => {
  it("requires the same minor version while the major version is 0", () => {
    expect(isCompatibleSchemaVersion("0.1.0", "0.1.0")).toBe(true);
    expect(isCompatibleSchemaVersion("0.1.7", "0.1.0")).toBe(true);
    expect(isCompatibleSchemaVersion("0.2.0", "0.1.0")).toBe(false);
    expect(isCompatibleSchemaVersion("0.1.0", "0.2.0")).toBe(false);
  });

  it("accepts any minor or patch of the same major version from 1.0.0", () => {
    expect(isCompatibleSchemaVersion("1.0.0", "1.2.0")).toBe(true);
    expect(isCompatibleSchemaVersion("1.5.3", "1.2.0")).toBe(true);
    expect(isCompatibleSchemaVersion("2.0.0", "1.2.0")).toBe(false);
    expect(isCompatibleSchemaVersion("0.9.0", "1.0.0")).toBe(false);
  });

  it("rejects values that are not MAJOR.MINOR.PATCH", () => {
    for (const value of ["3", "1.0", "v1.0.0", "1.0.0-dev", 3, null, undefined]) {
      expect(isCompatibleSchemaVersion(value, "1.0.0")).toBe(false);
    }
  });
});
