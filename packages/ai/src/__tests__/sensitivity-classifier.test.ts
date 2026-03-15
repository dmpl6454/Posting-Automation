import { describe, it, expect } from "vitest";
import { classifySensitivity } from "../tools/sensitivity-classifier";

describe("Sensitivity Classifier", () => {
  describe("HIGH sensitivity", () => {
    it("should classify political content as HIGH", () => {
      expect(classifySensitivity("President announces new election date")).toBe("HIGH");
    });

    it("should classify violence content as HIGH", () => {
      expect(classifySensitivity("Multiple people killed in attack")).toBe("HIGH");
    });

    it("should classify war-related content as HIGH", () => {
      expect(classifySensitivity("War escalates in the region")).toBe("HIGH");
    });

    it("should classify religious content as HIGH", () => {
      expect(classifySensitivity("Religious tensions rise in the city")).toBe("HIGH");
    });

    it("should detect HIGH keywords in summary even if title is clean", () => {
      expect(
        classifySensitivity("Breaking news update", "Three people dead after shooting")
      ).toBe("HIGH");
    });
  });

  describe("MEDIUM sensitivity", () => {
    it("should classify controversy as MEDIUM", () => {
      expect(classifySensitivity("Tech company faces controversy over data practices")).toBe(
        "MEDIUM"
      );
    });

    it("should classify backlash content as MEDIUM", () => {
      expect(classifySensitivity("CEO faces backlash after comments")).toBe("MEDIUM");
    });

    it("should classify layoff content as MEDIUM", () => {
      expect(classifySensitivity("Major tech company announces layoff of 500 employees")).toBe(
        "MEDIUM"
      );
    });

    it("should classify boycott content as MEDIUM", () => {
      expect(classifySensitivity("Consumers call for boycott of brand")).toBe("MEDIUM");
    });
  });

  describe("LOW sensitivity", () => {
    it("should classify neutral tech news as LOW", () => {
      expect(classifySensitivity("Google launches new AI model for developers")).toBe("LOW");
    });

    it("should classify product launches as LOW", () => {
      expect(classifySensitivity("Apple releases new iPhone with better camera")).toBe("LOW");
    });

    it("should classify generic news as LOW", () => {
      expect(classifySensitivity("New study reveals benefits of green tea")).toBe("LOW");
    });
  });

  describe("edge cases", () => {
    it("should handle empty summary", () => {
      expect(classifySensitivity("Just a normal headline")).toBe("LOW");
    });

    it("should be case-insensitive", () => {
      expect(classifySensitivity("PRESIDENT ANNOUNCES NEW POLICY")).toBe("HIGH");
    });
  });
});
