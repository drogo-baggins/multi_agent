import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resplitWorkUnit, parseDecompositionResponse } from "./task-decomposer.js";
import type { WorkUnit } from "./work-unit.js";
import { MAX_DECOMPOSITION_DEPTH, MAX_WORK_UNITS } from "./work-unit.js";

describe("parseDecompositionResponse", () => {
  it("parses valid JSON array of work units", () => {
    const response = JSON.stringify([
      { goal: "Survey vendors", scope: "Top 5 MDM vendors" },
      { goal: "Compare features", scope: "Feature matrix" }
    ]);
    const units = parseDecompositionResponse(response);
    assert.equal(units.length, 2);
    assert.equal(units[0]!.goal, "Survey vendors");
  });

  it("returns single unit for unparseable response", () => {
    const units = parseDecompositionResponse("Just do the whole research");
    assert.equal(units.length, 1);
    assert.equal(units[0]!.goal, "Just do the whole research");
  });

  it("caps at MAX_WORK_UNITS", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ goal: `Unit ${i}`, scope: `Scope ${i}` }));
    const units = parseDecompositionResponse(JSON.stringify(items));
    assert.equal(units.length, MAX_WORK_UNITS);
  });

  it("extracts JSON from surrounding text", () => {
    const response = 'Here is my analysis:\n[{"goal":"A","scope":"B"}]\nDone.';
    const units = parseDecompositionResponse(response);
    assert.equal(units.length, 1);
    assert.equal(units[0]!.goal, "A");
  });

  it("handles empty JSON array as fallback", () => {
    const units = parseDecompositionResponse("[]");
    assert.equal(units.length, 1); // fallback: empty array → single unit
  });
});

describe("resplitWorkUnit", () => {
  it("creates child units with incremented depth", () => {
    const parent: WorkUnit = {
      id: "abc",
      goal: "Security evaluation",
      scope: "All aspects",
      outOfScope: "",
      status: "timeout",
      depth: 0,
      parentId: null,
      retryCount: 0
    };
    const children = [
      { goal: "Auth analysis", scope: "Authentication mechanisms" },
      { goal: "Encryption analysis", scope: "Data encryption" }
    ];
    const result = resplitWorkUnit(parent, children);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.depth, 1);
    assert.equal(result[0]!.parentId, "abc");
  });

  it("throws when max depth exceeded", () => {
    const parent: WorkUnit = {
      id: "abc",
      goal: "Deep task",
      scope: "scope",
      outOfScope: "",
      status: "timeout",
      depth: MAX_DECOMPOSITION_DEPTH,
      parentId: null,
      retryCount: 0
    };
    assert.throws(
      () => resplitWorkUnit(parent, [{ goal: "child", scope: "child" }]),
      /maximum decomposition depth/i
    );
  });
});
