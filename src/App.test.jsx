import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App, {
  STORAGE_KEY,
  createEmptyWorkspace,
  createInitialWorkspace,
  getPlanStats,
  loadWorkspace,
  parseGuestLines,
  parseWorkspaceImport,
  workspaceReducer,
} from "./App.jsx";
import { PLAN_CONFIGURATIONS } from "./plan-configurations.js";
import {
  createPlanHtmlExportFilename,
  serializePlanAsHtml,
} from "./plan-html-export.js";
import { serializeWorkspace } from "./workspace-transfer.js";

function makeWorkspace() {
  return {
    version: 1,
    standardTableCapacity: 10,
    activePlanId: "plan-main",
    plans: [
      {
        id: "plan-main",
        name: "Piano principale",
        tables: [{ id: "table-ulivo", number: 1, name: "Ulivo", capacity: 1 }],
        guests: [
          { id: "guest-anna", name: "Anna", tableId: null, position: null },
          {
            id: "guest-luca",
            name: "Luca",
            tableId: "table-ulivo",
            position: 1,
          },
        ],
      },
    ],
  };
}

describe("dominio del pianificatore", () => {
  it("prepara la disposizione completa al primo avvio", () => {
    const workspace = createInitialWorkspace();
    const plan = workspace.plans[0];

    expect(plan.tables).toHaveLength(16);
    expect(plan.guests).toHaveLength(122);
    expect(getPlanStats(plan)).toEqual({
      tables: 16,
      total: 122,
      assigned: 122,
      unassigned: 0,
      overflow: 0,
    });
    expect(plan.guests.some((guest) => /rao/i.test(guest.name))).toBe(false);

    const staffTable = plan.tables.find((table) => table.name === "Staff");
    expect(staffTable.capacity).toBe(10);
    expect(
      plan.guests.filter((guest) => guest.tableId !== staffTable.id),
    ).toHaveLength(117);

    for (const table of plan.tables) {
      const occupancy = plan.guests.filter(
        (guest) => guest.tableId === table.id,
      ).length;
      expect(table.capacity).toBe(10);
      expect(occupancy).toBeLessThanOrEqual(table.capacity);
    }
  });

  it("carica il preset numerato e identifica tavoli provvisori e staff", () => {
    const [configuration] = PLAN_CONFIGURATIONS;

    expect(configuration.tables.map((table) => table.number)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    expect(configuration.tables.every((table) => table.capacity === 10)).toBe(
      true,
    );
    expect(
      configuration.tables
        .filter((table) => table.provisional)
        .map((table) => table.number),
    ).toEqual([8, 9, 10, 11]);
    expect(configuration.tables.at(-1)).toMatchObject({
      number: 16,
      name: "Staff",
      category: "staff",
    });
  });

  it("crea copie indipendenti del preset senza sovrascrivere altri piani", () => {
    const workspace = createInitialWorkspace();
    const updated = workspaceReducer(workspace, {
      type: "plan/from-configuration",
      configuration: PLAN_CONFIGURATIONS[0],
    });

    expect(updated.plans).toHaveLength(2);
    expect(updated.plans[1].name).toBe("Piano principale (2)");
    expect(updated.plans[1].tables[0].id).not.toBe(
      updated.plans[0].tables[0].id,
    );
    expect(updated.plans[1].guests[0].id).not.toBe(
      updated.plans[0].guests[0].id,
    );
    expect(updated.activePlanId).toBe(updated.plans[1].id);
  });

  it("usa la disposizione completa solo quando non esistono dati salvati", () => {
    const storage = { getItem: () => null };

    const result = loadWorkspace(storage);

    expect(result.recoveryRequired).toBe(false);
    expect(result.workspace.plans[0].tables).toHaveLength(16);
    expect(result.workspace.plans[0].guests).toHaveLength(122);
  });

  it("aggiorna il vecchio piano predefinito vuoto senza toccare piani compilati", () => {
    const emptyStorage = {
      getItem: () => JSON.stringify(createEmptyWorkspace()),
    };
    const legacyWorkspace = makeWorkspace();
    delete legacyWorkspace.standardTableCapacity;
    legacyWorkspace.plans[0].guests.forEach((guest) => {
      delete guest.position;
    });
    const populatedStorage = { getItem: () => JSON.stringify(legacyWorkspace) };

    expect(loadWorkspace(emptyStorage).workspace.plans[0].guests).toHaveLength(
      122,
    );
    const migratedWorkspace = loadWorkspace(populatedStorage).workspace;
    expect(migratedWorkspace.plans[0].guests).toEqual(
      makeWorkspace().plans[0].guests,
    );
    expect(migratedWorkspace.plans[0].tables[0]).toMatchObject({
      id: "table-ulivo",
      name: "Ulivo",
      capacity: 10,
      number: 1,
    });
  });

  it("usa un JSON leggibile dall’IA senza esporre gli identificativi interni", () => {
    const workspace = createInitialWorkspace();
    const exportedJson = serializeWorkspace(workspace);
    const configuration = JSON.parse(exportedJson);
    const firstTable = configuration.piani[0].tavoli["tavolo 1"];

    expect(configuration).toMatchObject({
      versione: 1,
      pianoAttivo: 0,
    });
    expect(firstTable).toEqual({
      nome: "Sposi",
      capienza: 10,
      persone: ["Ennio", "Stellina"],
    });
    expect(exportedJson).not.toMatch(/"(?:id|tableId|activePlanId)"/);
  });

  it("salva tutti gli scenari nello stesso JSON indicando quello attivo", () => {
    const workspace = makeWorkspace();
    workspace.plans.push({
      id: "plan-alternative",
      name: "Alternativa",
      tables: [],
      guests: [],
    });
    workspace.activePlanId = "plan-alternative";

    const configuration = JSON.parse(serializeWorkspace(workspace));

    expect(configuration.pianoAttivo).toBe(1);
    expect(configuration.piani.map((plan) => plan.nome)).toEqual([
      "Piano principale",
      "Alternativa",
    ]);
  });

  it("reimporta nomi, assegnazioni e proprietà rigenerando solo gli ID interni", () => {
    const workspace = makeWorkspace();
    workspace.plans[0].tables[0] = {
      ...workspace.plans[0].tables[0],
      number: 3,
      provisional: true,
      category: "staff",
      notes: "Vicino all’ingresso",
    };

    const imported = parseWorkspaceImport(serializeWorkspace(workspace));
    const [plan] = imported.plans;
    const [table] = plan.tables;

    expect(imported.activePlanId).toBe(plan.id);
    expect(table).toMatchObject({
      number: 1,
      name: "Ulivo",
      capacity: 1,
      provisional: true,
      category: "staff",
      notes: "Vicino all’ingresso",
    });
    expect(plan.guests.map(({ name, tableId }) => ({ name, tableId }))).toEqual(
      [
        { name: "Luca", tableId: table.id },
        { name: "Anna", tableId: null },
      ],
    );
    expect(table.id).not.toBe("table-ulivo");
  });

  it("accetta una configurazione modificata a mano senza identificatori", () => {
    const imported = parseWorkspaceImport(
      JSON.stringify({
        versione: 1,
        pianoAttivo: 0,
        piani: [
          {
            nome: "Proposta IA",
            tavoli: {
              "tavolo 4": {
                nome: "Amici",
                capienza: 10,
                persone: ["Gabriele", "Gabriele"],
              },
            },
            daSistemare: ["Marta"],
          },
        ],
      }),
    );
    const [plan] = imported.plans;

    expect(plan.name).toBe("Proposta IA");
    expect(plan.tables[0]).toMatchObject({ number: 1, name: "Amici" });
    expect(plan.guests.map((guest) => guest.name)).toEqual([
      "Gabriele",
      "Gabriele",
      "Marta",
    ]);
    expect(new Set(plan.guests.map((guest) => guest.id))).toHaveProperty(
      "size",
      3,
    );
    expect(plan.guests.at(-1).tableId).toBeNull();
  });

  it("esporta il piano attivo in un HTML autonomo, ordinato e sicuro", () => {
    const plan = makeWorkspace().plans[0];
    plan.name = 'Famiglia <script>alert("x")</script>';
    plan.tables.push({
      id: "table-rosa",
      number: 1,
      name: "Rosa & Lavanda",
      capacity: 10,
    });
    plan.tables[0].number = 2;
    const exportedAt = new Date("2026-08-08T12:00:00.000Z");

    const html = serializePlanAsHtml(plan, exportedAt);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(html.indexOf("Rosa &amp; Lavanda")).toBeLessThan(
      html.indexOf("Ulivo"),
    );
    expect(html).toContain(
      "Famiglia &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("Da sistemare");
    expect(createPlanHtmlExportFilename(plan, exportedAt)).toBe(
      "tavoli-famiglia-script-alert-x-script-2026-08-08.html",
    );
  });

  it("rifiuta import non validi prima di sostituire il workspace", () => {
    expect(() => parseWorkspaceImport("{non-json")).toThrow(
      "Il file non contiene JSON valido.",
    );
    expect(() => parseWorkspaceImport(JSON.stringify({ piani: [] }))).toThrow(
      "Il file non contiene una configurazione valida.",
    );
  });

  it("normalizza le righe senza eliminare gli omonimi", () => {
    expect(parseGuestLines("  Anna  \n\nLuca\r\nAnna\n   ")).toEqual([
      "Anna",
      "Luca",
      "Anna",
    ]);
  });

  it("crea un tavolo e assegna subito gli ospiti inseriti con esso", () => {
    const workspace = createEmptyWorkspace();
    const updated = workspaceReducer(workspace, {
      type: "table/add",
      name: "  Gelsomino ",
      capacity: 8,
      guestNames: ["Marta", "Paolo"],
    });
    const plan = updated.plans[0];

    expect(plan.tables).toHaveLength(1);
    expect(plan.tables[0]).toMatchObject({
      number: 1,
      name: "Gelsomino",
      capacity: 8,
    });
    expect(plan.guests.map((guest) => guest.name)).toEqual(["Marta", "Paolo"]);
    expect(
      plan.guests.every((guest) => guest.tableId === plan.tables[0].id),
    ).toBe(true);
    expect(plan.guests.map((guest) => guest.position)).toEqual([1, 2]);
  });

  it("ricalcola tutti i numeri quando un tavolo viene riordinato", () => {
    const workspace = makeWorkspace();
    const withSecondTable = workspaceReducer(workspace, {
      type: "table/add",
      name: "Quercia",
      number: 27,
      capacity: 10,
      guestNames: [],
    });
    const withThirdTable = workspaceReducer(withSecondTable, {
      type: "table/add",
      name: "Limone",
      number: 42,
      capacity: 10,
      guestNames: [],
    });
    const [firstTable, secondTable, thirdTable] =
      withThirdTable.plans[0].tables;

    const movedForward = workspaceReducer(withThirdTable, {
      type: "table/reorder",
      tableId: firstTable.id,
      targetIndex: 2,
    });

    expect(
      movedForward.plans[0].tables.map(({ id, number }) => ({ id, number })),
    ).toEqual([
      { id: secondTable.id, number: 1 },
      { id: thirdTable.id, number: 2 },
      { id: firstTable.id, number: 3 },
    ]);

    const movedBackward = workspaceReducer(movedForward, {
      type: "table/reorder",
      tableId: firstTable.id,
      targetIndex: 1,
    });

    expect(
      movedBackward.plans[0].tables.map(({ id, number }) => ({ id, number })),
    ).toEqual([
      { id: secondTable.id, number: 1 },
      { id: firstTable.id, number: 2 },
      { id: thirdTable.id, number: 3 },
    ]);
  });

  it("ignora numeri manuali e assegna il numero dalla posizione", () => {
    const workspace = makeWorkspace();
    const withSecondTable = workspaceReducer(workspace, {
      type: "table/add",
      name: "Quercia",
      number: 99,
      capacity: 10,
      guestNames: [],
    });

    const edited = workspaceReducer(withSecondTable, {
      type: "table/edit",
      tableId: withSecondTable.plans[0].tables[1].id,
      name: "Quercia rinominata",
      number: 1,
      capacity: 12,
    });

    expect(edited.plans[0].tables).toMatchObject([
      { name: "Ulivo", number: 1 },
      { name: "Quercia rinominata", number: 2, capacity: 12 },
    ]);
  });

  it("consente assegnazioni oltre capienza e conteggia i posti eccedenti", () => {
    const workspace = makeWorkspace();
    const updated = workspaceReducer(workspace, {
      type: "guest/move",
      guestId: "guest-anna",
      tableId: "table-ulivo",
    });

    expect(updated.plans[0].guests[0].tableId).toBe("table-ulivo");
    expect(updated.plans[0].guests[0].position).toBe(2);
    expect(getPlanStats(updated.plans[0])).toEqual({
      tables: 1,
      total: 2,
      assigned: 2,
      unassigned: 0,
      overflow: 1,
    });
  });

  it("salva il posto esatto quando un invitato viene inserito tra altri due", () => {
    const workspace = makeWorkspace();
    workspace.plans[0].guests = [
      { id: "anna", name: "Anna", tableId: "table-ulivo", position: 1 },
      { id: "luca", name: "Luca", tableId: "table-ulivo", position: 2 },
      { id: "marta", name: "Marta", tableId: "table-ulivo", position: 3 },
    ];

    const updated = workspaceReducer(workspace, {
      type: "guest/move",
      guestId: "marta",
      tableId: "table-ulivo",
      targetIndex: 1,
    });

    expect(
      [...updated.plans[0].guests]
        .sort((first, second) => first.position - second.position)
        .map(({ name, position }) => ({ name, position })),
    ).toEqual([
      { name: "Anna", position: 1 },
      { name: "Marta", position: 2 },
      { name: "Luca", position: 3 },
    ]);
  });

  it("mantiene l’ordine dei posti nell’export anche se l’array interno è diverso", () => {
    const workspace = makeWorkspace();
    workspace.plans[0].guests = [
      { id: "anna", name: "Anna", tableId: "table-ulivo", position: 2 },
      { id: "luca", name: "Luca", tableId: "table-ulivo", position: 1 },
    ];

    const exported = JSON.parse(serializeWorkspace(workspace));

    expect(exported.piani[0].tavoli["tavolo 1"].persone).toEqual([
      "Luca",
      "Anna",
    ]);
  });

  it("elimina un tavolo senza lasciare buchi nella numerazione", () => {
    const workspace = makeWorkspace();
    const withSecondTable = workspaceReducer(workspace, {
      type: "table/add",
      name: "Quercia",
      capacity: 10,
      guestNames: [],
    });
    const withThirdTable = workspaceReducer(withSecondTable, {
      type: "table/add",
      name: "Limone",
      capacity: 10,
      guestNames: [],
    });

    const updated = workspaceReducer(withThirdTable, {
      type: "table/delete",
      tableId: "table-ulivo",
    });

    expect(updated.plans[0].tables).toMatchObject([
      { name: "Quercia", number: 1 },
      { name: "Limone", number: 2 },
    ]);
    expect(
      updated.plans[0].guests.find((guest) => guest.id === "guest-luca")
        .tableId,
    ).toBeNull();
  });

  it("duplica un piano con identità indipendenti e permette di cambiare piano", () => {
    const workspace = makeWorkspace();
    const duplicated = workspaceReducer(workspace, {
      type: "plan/duplicate",
      planId: "plan-main",
    });
    const copy = duplicated.plans[1];

    expect(copy.name).toBe("Piano principale — copia");
    expect(copy.id).not.toBe("plan-main");
    expect(copy.tables[0].id).not.toBe("table-ulivo");
    expect(copy.guests[1].tableId).toBe(copy.tables[0].id);
    expect(duplicated.activePlanId).toBe(copy.id);

    const editedCopy = workspaceReducer(duplicated, {
      type: "guest/edit",
      guestId: copy.guests[1].id,
      name: "Luca nella copia",
    });
    expect(editedCopy.plans[0].guests[1].name).toBe("Luca");
    expect(editedCopy.plans[1].guests[1].name).toBe("Luca nella copia");

    const switched = workspaceReducer(editedCopy, {
      type: "plan/switch",
      planId: "plan-main",
    });
    expect(switched.activePlanId).toBe("plan-main");
  });
});

describe("persistenza e percorsi accessibili", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("recupera con un piano vuoto quando lo storage non è valido", () => {
    const invalidStorage = {
      getItem: () => "{non-json",
    };

    const result = loadWorkspace(invalidStorage);

    expect(result.recoveryRequired).toBe(true);
    expect(result.workspace.plans).toHaveLength(1);
    expect(result.workspace.plans[0]).toMatchObject({
      name: "Piano principale",
      guests: [],
      tables: [],
    });
  });

  it("non sovrascrive dati corrotti finché il recupero non viene confermato", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, "{non-json");
    render(<App />);

    expect(screen.getByRole("alert")).toHaveTextContent("non sono leggibili");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("{non-json");

    await user.click(
      screen.getByRole("button", { name: "Usa il piano vuoto" }),
    );

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).version).toBe(1);
    });
  });

  it("sposta un invitato con il menu accessibile usando la stessa assegnazione", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeWorkspace()));
    render(<App />);

    await user.selectOptions(
      screen.getByLabelText("Sposta Anna"),
      "table-ulivo",
    );

    const tableCard = screen
      .getByRole("heading", { name: "Ulivo" })
      .closest("article");
    expect(within(tableCard).getByText("Anna")).toBeInTheDocument();
    expect(screen.getByText("1 posto eccedente")).toBeInTheDocument();
  });

  it("mostra gli invitati per posto con il richiamo all’ordine circolare", () => {
    const workspace = makeWorkspace();
    workspace.plans[0].guests = [
      { id: "anna", name: "Anna", tableId: "table-ulivo", position: 2 },
      { id: "luca", name: "Luca", tableId: "table-ulivo", position: 1 },
      { id: "matteo", name: "Matteo", tableId: "table-ulivo", position: 3 },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));

    render(<App />);

    const tableCard = screen
      .getByRole("heading", { name: "Ulivo" })
      .closest("article");
    const names = [...tableCard.querySelectorAll(".guest-name")].map(
      (element) => element.textContent,
    );
    expect(names).toEqual(["Luca", "Anna", "Matteo"]);
    const circularOrderHint = within(tableCard).getByLabelText(
      "L’ultimo posto è accanto al primo",
    );
    expect(circularOrderHint).toBeInTheDocument();
    expect(circularOrderHint).toBeEmptyDOMElement();
  });

  it("nasconde il richiamo circolare con meno di tre invitati", () => {
    const workspace = makeWorkspace();
    workspace.plans[0].guests.push({
      id: "anna",
      name: "Anna",
      tableId: "table-ulivo",
      position: 2,
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));

    render(<App />);

    const tableCard = screen
      .getByRole("heading", { name: "Ulivo" })
      .closest("article");
    expect(
      within(tableCard).queryByLabelText("L’ultimo posto è accanto al primo"),
    ).not.toBeInTheDocument();
  });

  it("rimette un partecipante assegnato tra quelli da sistemare", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeWorkspace()));
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Rimetti Luca da sistemare" }),
    );

    const waitingCard = screen
      .getByText("Da sistemare", { selector: "h2" })
      .closest("aside");
    expect(within(waitingCard).getByText("Luca")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rimetti Luca da sistemare" }),
    ).not.toBeInTheDocument();
  });

  it("aggiunge per default i piani importati senza perdere quelli salvati", async () => {
    const user = userEvent.setup();
    const importedWorkspace = createEmptyWorkspace();
    importedWorkspace.plans[0].name = "Piano importato";
    const file = new File(
      [serializeWorkspace(importedWorkspace)],
      "configurazione.json",
      { type: "application/json" },
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeWorkspace()));
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Importa JSON" }));
    await user.upload(screen.getByLabelText("File JSON"), file);

    expect(
      await screen.findByText("1 piano · 0 tavoli · 0 persone"),
    ).toBeVisible();
    expect(
      screen.getByRole("radio", { name: /Aggiungi ai piani esistenti/ }),
    ).toBeChecked();
    expect(screen.getByText("Si aggiungerà a 1 piano salvato")).toBeVisible();
    expect(screen.getByRole("option", { name: "Piano principale" })).toBe(
      screen.getByLabelText("Piano attivo").selectedOptions[0],
    );

    await user.click(screen.getByRole("button", { name: "Aggiungi piani" }));

    expect(screen.getByRole("option", { name: "Piano importato" })).toBe(
      screen.getByLabelText("Piano attivo").selectedOptions[0],
    );
    expect(
      screen.getByRole("option", { name: "Piano principale" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 piani salvati")).toBeVisible();
    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem(STORAGE_KEY)).plans.map(
          (plan) => plan.name,
        ),
      ).toEqual(["Piano principale", "Piano importato"]);
    });
  });

  it("sostituisce l’archivio solo quando viene scelta l’opzione distruttiva", async () => {
    const user = userEvent.setup();
    const importedWorkspace = createEmptyWorkspace();
    importedWorkspace.plans[0].name = "Archivio ripristinato";
    const file = new File(
      [serializeWorkspace(importedWorkspace)],
      "archivio.json",
      { type: "application/json" },
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeWorkspace()));
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Importa JSON" }));
    await user.upload(screen.getByLabelText("File JSON"), file);
    await user.click(
      await screen.findByRole("radio", {
        name: /Sostituisci tutti i piani/,
      }),
    );

    expect(screen.getByText("Sostituirà tutti i piani salvati")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Importa e sostituisci" }),
    );

    expect(
      screen.queryByRole("option", { name: "Piano principale" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Archivio ripristinato" })).toBe(
      screen.getByLabelText("Piano attivo").selectedOptions[0],
    );
  });

  it("crea un piano vuoto e permette di tornare allo scenario precedente", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeWorkspace()));
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Nuovo vuoto" }));
    expect(
      screen.getByText(/Tutti i piani esistenti resteranno disponibili/),
    ).toBeVisible();
    await user.type(screen.getByLabelText("Nome del piano"), "Alternativa");
    await user.click(screen.getByRole("button", { name: "Crea piano" }));

    expect(screen.getByRole("option", { name: "Alternativa" })).toBe(
      screen.getByLabelText("Piano attivo").selectedOptions[0],
    );
    expect(
      screen.getByRole("heading", { name: "La sala è ancora vuota" }),
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Piano attivo"),
      "plan-main",
    );
    expect(screen.getByRole("heading", { name: "Ulivo" })).toBeInTheDocument();
  });

  it("crea un nuovo piano da configurazione e mostra il numero di tavoli", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeWorkspace()));
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Da configurazione" }));
    const dialog = screen.getByRole("dialog", {
      name: "Crea da configurazione",
    });
    expect(within(dialog).getByText("16 tavoli · 122 persone")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Crea piano" }),
    );

    expect(screen.getByRole("heading", { name: "Sposi" })).toBeInTheDocument();
    const stats = screen.getByLabelText("Riepilogo del piano");
    expect(within(stats).getByText("Tavoli")).toBeInTheDocument();
    expect(within(stats).getByText("16")).toBeInTheDocument();
  });

  it("rinomina un tavolo senza esporre la modifica manuale del numero", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeWorkspace()));
    render(<App />);

    const tableCard = screen
      .getByRole("heading", { name: "Ulivo" })
      .closest("article");
    await user.click(
      within(tableCard).getByRole("button", { name: "Rinomina / modifica" }),
    );

    const nameInput = screen.getByLabelText("Nome del tavolo");
    await user.clear(nameInput);
    await user.type(nameInput, "Quercia");
    expect(screen.queryByLabelText("Numero")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Salva modifiche" }));

    expect(
      screen.getByRole("heading", { name: "Quercia" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tavolo 01")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trascina tavolo Quercia" }),
    ).toBeInTheDocument();
  });

  it("crea un tavolo dall’interfaccia con capienza e invitati iniziali", async () => {
    const user = userEvent.setup();
    const emptyWorkspace = createEmptyWorkspace();
    emptyWorkspace.plans[0].name = "Piano di test vuoto";
    localStorage.setItem(STORAGE_KEY, JSON.stringify(emptyWorkspace));
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Crea il primo tavolo" }),
    );
    await user.type(screen.getByLabelText("Nome del tavolo"), "Limone");
    const capacity = screen.getByLabelText("Capienza");
    await user.clear(capacity);
    await user.type(capacity, "2");
    await user.type(
      screen.getByLabelText(/Ospiti già assegnati/),
      "Ada\nPiero\nNina",
    );
    await user.click(screen.getByRole("button", { name: "Crea tavolo" }));

    expect(screen.getByRole("heading", { name: "Limone" })).toBeInTheDocument();
    expect(screen.getByText("1 posto eccedente")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });
});
