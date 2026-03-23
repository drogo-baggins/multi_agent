import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkUnit, createDecompositionPlan, type WorkUnit } from "./work-unit.js";

describe("createWorkUnit", () => {
  it("creates a work unit with required fields", () => {
    const unit = createWorkUnit({
      goal: "Investigate MDM vendor landscape",
      scope: "List top 5 MDM vendors with market share",
      outOfScope: "Detailed pricing analysis"
    });

    assert.equal(unit.goal, "Investigate MDM vendor landscape");
    assert.equal(unit.scope, "List top 5 MDM vendors with market share");
    assert.equal(unit.outOfScope, "Detailed pricing analysis");
    assert.equal(unit.status, "pending");
    assert.equal(unit.depth, 0);
    assert.ok(unit.id.length > 0);
  });

  it("assigns unique IDs", () => {
    const a = createWorkUnit({ goal: "A", scope: "A" });
    const b = createWorkUnit({ goal: "B", scope: "B" });
    assert.notEqual(a.id, b.id);
  });
});

describe("createDecompositionPlan", () => {
  it("creates plan with metadata", () => {
    const units: WorkUnit[] = [
      createWorkUnit({ goal: "A", scope: "A" }),
      createWorkUnit({ goal: "B", scope: "B" })
    ];
    const plan = createDecompositionPlan("Research MDM tools", units);

    assert.equal(plan.originalTask, "Research MDM tools");
    assert.equal(plan.workUnits.length, 2);
    assert.ok(plan.createdAt.length > 0);
  });
});
