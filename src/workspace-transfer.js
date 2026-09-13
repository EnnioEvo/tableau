import { getGuestsAtTable } from "./guest-order.js";

export const CONFIGURATION_VERSION = 1;

const TABLE_KEY_PATTERN = /^tavolo ([1-9]\d*)$/;
const TABLE_CATEGORIES = {
  invitati: "guests",
  staff: "staff",
};

function createRuntimeId(prefix) {
  const uniquePart =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `${prefix}-${uniquePart}`;
}

function serializeTable(table, guests) {
  const serializedTable = {
    nome: table.name,
    capienza: table.capacity,
    persone: getGuestsAtTable(guests, table.id).map((guest) => guest.name),
  };

  if (table.provisional) serializedTable.provvisorio = true;
  if (table.category === "staff") serializedTable.categoria = "staff";
  if (table.notes) serializedTable.note = table.notes;

  return serializedTable;
}

function serializePlan(plan) {
  const orderedTables = [...plan.tables].sort(
    (first, second) => first.number - second.number,
  );

  return {
    nome: plan.name,
    tavoli: Object.fromEntries(
      orderedTables.map((table) => [
        `tavolo ${table.number}`,
        serializeTable(table, plan.guests),
      ]),
    ),
    daSistemare: plan.guests
      .filter((guest) => guest.tableId === null)
      .map((guest) => guest.name),
  };
}

export function serializeWorkspace(workspace) {
  const activePlanIndex = workspace.plans.findIndex(
    (plan) => plan.id === workspace.activePlanId,
  );

  return JSON.stringify(
    {
      versione: CONFIGURATION_VERSION,
      pianoAttivo: activePlanIndex,
      piani: workspace.plans.map(serializePlan),
    },
    null,
    2,
  );
}

function assertGuestNames(value, location) {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || !name.trim())
  ) {
    throw new Error(`${location} deve essere una lista di nomi.`);
  }
}

function parseTable(tableKey, value, createId) {
  const match = TABLE_KEY_PATTERN.exec(tableKey);
  if (!match) {
    throw new Error(`La chiave "${tableKey}" deve avere la forma "tavolo N".`);
  }

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.nome !== "string" ||
    !value.nome.trim() ||
    !Number.isInteger(value.capienza) ||
    value.capienza < 1
  ) {
    throw new Error(`Il contenuto di "${tableKey}" non è valido.`);
  }

  assertGuestNames(value.persone, `Le persone di "${tableKey}"`);

  if (
    value.provvisorio !== undefined &&
    typeof value.provvisorio !== "boolean"
  ) {
    throw new Error(`"provvisorio" in "${tableKey}" deve essere booleano.`);
  }

  const category = value.categoria ?? "invitati";
  if (!Object.hasOwn(TABLE_CATEGORIES, category)) {
    throw new Error(`La categoria di "${tableKey}" non è valida.`);
  }

  if (value.note !== undefined && typeof value.note !== "string") {
    throw new Error(`Le note di "${tableKey}" devono essere testo.`);
  }

  return {
    table: {
      id: createId("table"),
      number: Number(match[1]),
      name: value.nome.trim(),
      capacity: value.capienza,
      provisional: value.provvisorio ?? false,
      category: TABLE_CATEGORIES[category],
      notes: value.note ?? "",
    },
    guestNames: value.persone.map((name) => name.trim()),
  };
}

function parsePlan(value, createId, planIndex) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.nome !== "string" ||
    !value.nome.trim() ||
    !value.tavoli ||
    typeof value.tavoli !== "object" ||
    Array.isArray(value.tavoli)
  ) {
    throw new Error(`Il piano ${planIndex + 1} non è valido.`);
  }

  assertGuestNames(
    value.daSistemare,
    `"daSistemare" del piano ${planIndex + 1}`,
  );

  const parsedTables = Object.entries(value.tavoli).map(([tableKey, table]) =>
    parseTable(tableKey, table, createId),
  );
  const tableNumbers = parsedTables.map(({ table }) => table.number);
  if (new Set(tableNumbers).size !== tableNumbers.length) {
    throw new Error(
      `Il piano ${planIndex + 1} contiene numeri di tavolo duplicati.`,
    );
  }

  const tables = parsedTables
    .map(({ table }) => table)
    .sort((first, second) => first.number - second.number);
  const guests = parsedTables.flatMap(({ table, guestNames }) =>
    guestNames.map((name, index) => ({
      id: createId("guest"),
      name,
      tableId: table.id,
      position: index + 1,
    })),
  );

  guests.push(
    ...value.daSistemare.map((name) => ({
      id: createId("guest"),
      name: name.trim(),
      tableId: null,
      position: null,
    })),
  );

  return {
    id: createId("plan"),
    name: value.nome.trim(),
    tables,
    guests,
  };
}

export function extractWorkspaceFromJson(value, createId = createRuntimeId) {
  let configuration;

  try {
    configuration = JSON.parse(value);
  } catch {
    throw new Error("Il file non contiene JSON valido.");
  }

  if (
    !configuration ||
    configuration.versione !== CONFIGURATION_VERSION ||
    !Array.isArray(configuration.piani) ||
    configuration.piani.length === 0 ||
    !Number.isInteger(configuration.pianoAttivo) ||
    configuration.pianoAttivo < 0 ||
    configuration.pianoAttivo >= configuration.piani.length
  ) {
    throw new Error("Il file non contiene una configurazione valida.");
  }

  const plans = configuration.piani.map((plan, index) =>
    parsePlan(plan, createId, index),
  );

  return {
    version: 1,
    standardTableCapacity: 10,
    activePlanId: plans[configuration.pianoAttivo].id,
    plans,
  };
}

export function createWorkspaceExportFilename(exportedAt = new Date()) {
  const date = exportedAt.toISOString().slice(0, 10);
  return `tableau-miriam-ennio-${date}.json`;
}

export function readTextFile(file) {
  if (typeof file.text === "function") return file.text();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () =>
      reject(new Error("Non è stato possibile leggere il file.")),
    );
    reader.readAsText(file);
  });
}

export function downloadWorkspaceExport(workspace) {
  const exportedAt = new Date();
  const blob = new Blob([serializeWorkspace(workspace)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = createWorkspaceExportFilename(exportedAt);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
