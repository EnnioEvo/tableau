export function getUniquePlanName(plans, requestedName) {
  const trimmedName = requestedName.trim();
  if (!plans.some((plan) => plan.name === trimmedName)) return trimmedName;

  let copyNumber = 2;
  let candidate = `${trimmedName} (${copyNumber})`;
  while (plans.some((plan) => plan.name === candidate)) {
    copyNumber += 1;
    candidate = `${trimmedName} (${copyNumber})`;
  }

  return candidate;
}

export function appendPlan(workspace, plan) {
  const appendedPlan = {
    ...plan,
    name: getUniquePlanName(workspace.plans, plan.name),
  };

  return {
    ...workspace,
    activePlanId: appendedPlan.id,
    plans: [...workspace.plans, appendedPlan],
  };
}

export function appendImportedWorkspace(workspace, importedWorkspace) {
  const importedPlans = [];
  let availablePlans = workspace.plans;

  for (const plan of importedWorkspace.plans) {
    const importedPlan = {
      ...plan,
      name: getUniquePlanName(availablePlans, plan.name),
    };

    importedPlans.push(importedPlan);
    availablePlans = [...availablePlans, importedPlan];
  }

  const importedActivePlan = importedPlans.find(
    (plan) => plan.id === importedWorkspace.activePlanId,
  );
  if (!importedActivePlan) {
    throw new Error("Il workspace importato non contiene il piano attivo.");
  }

  return {
    ...workspace,
    activePlanId: importedActivePlan.id,
    plans: [...workspace.plans, ...importedPlans],
  };
}

export function renamePlan(workspace, planId, requestedName) {
  const plan = workspace.plans.find((item) => item.id === planId);
  if (!plan) return workspace;

  const otherPlans = workspace.plans.filter((item) => item.id !== planId);
  const name = getUniquePlanName(otherPlans, requestedName);

  return {
    ...workspace,
    plans: workspace.plans.map((item) =>
      item.id === planId ? { ...item, name } : item,
    ),
  };
}

export function duplicatePlan(workspace, planId, createId) {
  const sourcePlan = workspace.plans.find((plan) => plan.id === planId);
  if (!sourcePlan) return workspace;

  const tableIdMap = new Map(
    sourcePlan.tables.map((table) => [table.id, createId("table")]),
  );
  const duplicatedPlan = {
    id: createId("plan"),
    name: `${sourcePlan.name} — copia`,
    tables: sourcePlan.tables.map((table) => ({
      ...table,
      id: tableIdMap.get(table.id),
    })),
    guests: sourcePlan.guests.map((guest) => ({
      ...guest,
      id: createId("guest"),
      tableId: guest.tableId ? tableIdMap.get(guest.tableId) : null,
    })),
  };

  return appendPlan(workspace, duplicatedPlan);
}

export function deletePlan(workspace, planId) {
  if (workspace.plans.length === 1) return workspace;

  const deletedIndex = workspace.plans.findIndex((plan) => plan.id === planId);
  if (deletedIndex === -1) return workspace;

  const plans = workspace.plans.filter((plan) => plan.id !== planId);
  if (workspace.activePlanId !== planId) return { ...workspace, plans };

  const adjacentPlan = plans[deletedIndex] ?? plans[deletedIndex - 1];
  return { ...workspace, activePlanId: adjacentPlan.id, plans };
}
