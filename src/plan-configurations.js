const configurationModules = import.meta.glob("./configurations/*.json", {
  eager: true,
  import: "default",
});

const TABLE_CATEGORIES = new Set(["guests", "staff"]);

function validateConfiguration(configuration, sourcePath) {
  if (
    !configuration ||
    typeof configuration.id !== "string" ||
    !configuration.id.trim() ||
    typeof configuration.name !== "string" ||
    !configuration.name.trim() ||
    typeof configuration.description !== "string" ||
    !Array.isArray(configuration.tables) ||
    configuration.tables.length === 0
  ) {
    throw new Error(`Configurazione non valida: ${sourcePath}`);
  }

  const tableIds = new Set();
  const tableNumbers = new Set();
  for (const table of configuration.tables) {
    const category = table.category ?? "guests";
    if (
      !table ||
      typeof table.id !== "string" ||
      !table.id.trim() ||
      tableIds.has(table.id) ||
      !Number.isInteger(table.number) ||
      table.number < 1 ||
      tableNumbers.has(table.number) ||
      typeof table.name !== "string" ||
      !table.name.trim() ||
      !Number.isInteger(table.capacity) ||
      table.capacity < 1 ||
      (table.provisional !== undefined &&
        typeof table.provisional !== "boolean") ||
      (table.notes !== undefined && typeof table.notes !== "string") ||
      !TABLE_CATEGORIES.has(category) ||
      !Array.isArray(table.guests) ||
      table.guests.some((guest) => typeof guest !== "string" || !guest.trim())
    ) {
      throw new Error(`Tavolo non valido in ${sourcePath}`);
    }

    tableIds.add(table.id);
    tableNumbers.add(table.number);
  }

  return configuration;
}

export const PLAN_CONFIGURATIONS = Object.entries(configurationModules)
  .map(([sourcePath, configuration]) =>
    validateConfiguration(configuration, sourcePath),
  )
  .sort((first, second) => first.name.localeCompare(second.name, "it"));

const configurationIds = new Set(
  PLAN_CONFIGURATIONS.map((configuration) => configuration.id),
);
if (configurationIds.size !== PLAN_CONFIGURATIONS.length) {
  throw new Error("Gli ID delle configurazioni devono essere univoci");
}

export function createPlanFromConfiguration(configuration, createId) {
  const configurationTables = [...configuration.tables].sort(
    (first, second) => first.number - second.number,
  );
  const tables = configurationTables.map((table, index) => ({
    id: createId("table"),
    number: index + 1,
    name: table.name,
    capacity: table.capacity,
    provisional: table.provisional ?? false,
    category: table.category ?? "guests",
    notes: table.notes ?? "",
  }));
  const guests = configurationTables.flatMap((table, tableIndex) =>
    table.guests.map((name, guestIndex) => ({
      id: createId("guest"),
      name,
      tableId: tables[tableIndex].id,
      position: guestIndex + 1,
    })),
  );

  return {
    id: createId("plan"),
    name: configuration.name,
    tables,
    guests,
  };
}
