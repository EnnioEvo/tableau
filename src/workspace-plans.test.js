import { describe, expect, it } from "vitest";

import {
  appendImportedWorkspace,
  appendPlan,
  deletePlan,
  duplicatePlan,
} from "./workspace-plans.js";

function makePlan(id, name) {
  return { id, name, tables: [], guests: [] };
}

function makeWorkspace(plans, activePlanId = plans[0].id) {
  return {
    version: 1,
    standardTableCapacity: 10,
    activePlanId,
    plans,
  };
}

describe("gestione multipiano", () => {
  it("aggiunge e attiva un piano senza modificare gli scenari esistenti", () => {
    const originalPlan = makePlan("plan-main", "Piano principale");
    const workspace = makeWorkspace([originalPlan]);

    const updated = appendPlan(
      workspace,
      makePlan("plan-new", "Piano principale"),
    );

    expect(updated.plans).toEqual([
      originalPlan,
      makePlan("plan-new", "Piano principale (2)"),
    ]);
    expect(updated.plans[0]).toBe(originalPlan);
    expect(updated.activePlanId).toBe("plan-new");
  });

  it("aggiunge tutti i piani importati e rispetta il loro piano attivo", () => {
    const localPlan = makePlan("plan-local", "Scenario");
    const importedFirst = makePlan("plan-imported-1", "Scenario");
    const importedSecond = makePlan("plan-imported-2", "Alternativa");
    const workspace = makeWorkspace([localPlan]);
    const importedWorkspace = makeWorkspace(
      [importedFirst, importedSecond],
      importedSecond.id,
    );

    const updated = appendImportedWorkspace(workspace, importedWorkspace);

    expect(updated.plans.map((plan) => plan.name)).toEqual([
      "Scenario",
      "Scenario (2)",
      "Alternativa",
    ]);
    expect(updated.activePlanId).toBe(importedSecond.id);
    expect(updated.plans[0]).toBe(localPlan);
  });

  it("duplica assegnazioni e posti usando identità indipendenti", () => {
    const sourcePlan = {
      id: "plan-source",
      name: "Scenario",
      tables: [{ id: "table-source", number: 1, name: "Ulivo" }],
      guests: [
        {
          id: "guest-source",
          name: "Anna",
          tableId: "table-source",
          position: 1,
        },
      ],
    };
    const workspace = makeWorkspace([sourcePlan]);
    let nextId = 0;

    const updated = duplicatePlan(
      workspace,
      sourcePlan.id,
      (prefix) => `${prefix}-copy-${++nextId}`,
    );
    const duplicatedPlan = updated.plans[1];

    expect(duplicatedPlan.id).not.toBe(sourcePlan.id);
    expect(duplicatedPlan.tables[0].id).not.toBe(sourcePlan.tables[0].id);
    expect(duplicatedPlan.guests[0]).toMatchObject({
      position: 1,
      tableId: duplicatedPlan.tables[0].id,
    });
    expect(updated.plans[0]).toBe(sourcePlan);
  });

  it("dopo l’eliminazione attiva il piano adiacente", () => {
    const firstPlan = makePlan("plan-1", "Primo");
    const middlePlan = makePlan("plan-2", "Secondo");
    const lastPlan = makePlan("plan-3", "Terzo");
    const workspace = makeWorkspace(
      [firstPlan, middlePlan, lastPlan],
      middlePlan.id,
    );

    const withoutMiddle = deletePlan(workspace, middlePlan.id);
    const withoutLast = deletePlan(
      { ...workspace, activePlanId: lastPlan.id },
      lastPlan.id,
    );

    expect(withoutMiddle.activePlanId).toBe(lastPlan.id);
    expect(withoutLast.activePlanId).toBe(middlePlan.id);
    const singlePlanWorkspace = makeWorkspace([firstPlan]);
    expect(deletePlan(singlePlanWorkspace, firstPlan.id)).toBe(
      singlePlanWorkspace,
    );
  });
});
