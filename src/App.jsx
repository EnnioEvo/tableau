import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Fragment, useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  PLAN_CONFIGURATIONS,
  createPlanFromConfiguration,
} from "./plan-configurations.js";
import {
  getGuestsAtTable,
  hasSequentialGuestPositions,
  moveGuestToPosition,
  normalizeGuestPositions,
} from "./guest-order.js";
import { downloadPlanHtmlExport } from "./plan-html-export.js";
import {
  downloadWorkspaceExport,
  extractWorkspaceFromJson,
  readTextFile,
} from "./workspace-transfer.js";
import {
  migrateTableOrder,
  recalculateTableNumbers,
  reorderTables,
} from "./table-order.js";
import {
  appendImportedWorkspace,
  appendPlan,
  deletePlan,
  duplicatePlan,
  renamePlan,
} from "./workspace-plans.js";
import { isSupabaseConfigured } from "./supabase.js";
import {
  loadRemoteWorkspace,
  saveRemoteWorkspace,
} from "./workspace-supabase.js";

export const STORAGE_KEY = "wedding-table-planner:v1";
export const WORKSPACE_VERSION = 1;
export const STANDARD_TABLE_CAPACITY = 10;

function detectDropTarget(arguments_) {
  const pointerCollisions = pointerWithin(arguments_);
  const collisions = pointerCollisions.length
    ? pointerCollisions
    : rectIntersection(arguments_);

  if (!String(arguments_.active.id).startsWith("table:")) {
    const guestInsertions = collisions.filter(({ id }) =>
      String(id).startsWith("guest-"),
    );
    if (guestInsertions.length) return guestInsertions;
  }

  return collisions;
}

function getTableDropIndex(targetId) {
  const match = /^table-(?:insert|placeholder):(\d+)/.exec(String(targetId));
  return match ? Number(match[1]) : null;
}

function getGuestDropTarget(targetId) {
  const match = /^guest-(?:insert|placeholder):([^:]+):(\d+)/.exec(
    String(targetId),
  );

  return match ? { tableId: match[1], targetIndex: Number(match[2]) } : null;
}

export function parseGuestLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createId(prefix) {
  const uniquePart =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uniquePart}`;
}

export function createEmptyWorkspace() {
  const planId = createId("plan");
  return {
    version: WORKSPACE_VERSION,
    standardTableCapacity: STANDARD_TABLE_CAPACITY,
    activePlanId: planId,
    plans: [{ id: planId, name: "Piano principale", guests: [], tables: [] }],
  };
}

export function createInitialWorkspace() {
  const initialConfiguration =
    PLAN_CONFIGURATIONS.find(
      (configuration) => configuration.id === "piano-principale",
    ) ?? PLAN_CONFIGURATIONS[0];
  const plan = createPlanFromConfiguration(initialConfiguration, createId);

  return {
    version: WORKSPACE_VERSION,
    standardTableCapacity: STANDARD_TABLE_CAPACITY,
    activePlanId: plan.id,
    plans: [plan],
  };
}

function normalizeStoredWorkspace(value) {
  if (!value || !Array.isArray(value.plans)) return value;

  const shouldStandardizeCapacity =
    value.standardTableCapacity !== STANDARD_TABLE_CAPACITY;

  return {
    ...value,
    standardTableCapacity: STANDARD_TABLE_CAPACITY,
    plans: value.plans.map((plan) => {
      if (!plan || !Array.isArray(plan.tables)) return plan;

      return {
        ...plan,
        tables: migrateTableOrder(plan.tables).map((table) => {
          if (!table || typeof table !== "object") return table;

          return {
            ...table,
            capacity: shouldStandardizeCapacity
              ? STANDARD_TABLE_CAPACITY
              : table.capacity,
            provisional: table.provisional ?? false,
            category: table.category ?? "guests",
            notes: table.notes ?? "",
          };
        }),
        guests:
          Array.isArray(plan.guests) &&
          plan.guests.every(
            (guest) =>
              guest && typeof guest === "object" && !Array.isArray(guest),
          )
            ? normalizeGuestPositions(plan.guests)
            : plan.guests,
      };
    }),
  };
}

export function parseWorkspaceImport(value) {
  const workspace = normalizeStoredWorkspace(
    extractWorkspaceFromJson(value, createId),
  );

  if (!isValidWorkspace(workspace)) {
    throw new Error("Il file non contiene una configurazione valida.");
  }

  return workspace;
}

function hasCalculatedTableNumbers(tables) {
  return tables.every((table, index) => table?.number === index + 1);
}

function isValidWorkspace(value) {
  if (
    !value ||
    value.version !== WORKSPACE_VERSION ||
    !Array.isArray(value.plans) ||
    value.plans.length === 0 ||
    typeof value.activePlanId !== "string"
  ) {
    return false;
  }

  const planIds = new Set();
  for (const plan of value.plans) {
    if (
      !plan ||
      typeof plan.id !== "string" ||
      typeof plan.name !== "string" ||
      !plan.name.trim() ||
      !Array.isArray(plan.guests) ||
      !Array.isArray(plan.tables) ||
      !hasCalculatedTableNumbers(plan.tables) ||
      !hasSequentialGuestPositions(plan.guests) ||
      planIds.has(plan.id)
    ) {
      return false;
    }
    planIds.add(plan.id);

    const tableIds = new Set();
    for (const table of plan.tables) {
      if (
        !table ||
        typeof table.id !== "string" ||
        typeof table.name !== "string" ||
        !table.name.trim() ||
        !Number.isInteger(table.number) ||
        table.number < 1 ||
        !Number.isInteger(table.capacity) ||
        table.capacity < 1 ||
        typeof table.provisional !== "boolean" ||
        !["guests", "staff"].includes(table.category) ||
        typeof table.notes !== "string" ||
        tableIds.has(table.id)
      ) {
        return false;
      }
      tableIds.add(table.id);
    }

    const guestIds = new Set();
    for (const guest of plan.guests) {
      if (
        !guest ||
        typeof guest.id !== "string" ||
        typeof guest.name !== "string" ||
        !guest.name.trim() ||
        (guest.tableId !== null && !tableIds.has(guest.tableId)) ||
        guestIds.has(guest.id)
      ) {
        return false;
      }
      guestIds.add(guest.id);
    }
  }

  return planIds.has(value.activePlanId);
}

function isUntouchedEmptyWorkspace(workspace) {
  if (workspace.plans.length !== 1) return false;

  const [plan] = workspace.plans;
  return (
    plan.name === "Piano principale" &&
    plan.guests.length === 0 &&
    plan.tables.length === 0
  );
}

export function loadWorkspace(storage = globalThis.localStorage) {
  const emptyWorkspace = createEmptyWorkspace();

  try {
    const storedValue = storage?.getItem(STORAGE_KEY);
    if (storedValue === null || storedValue === undefined) {
      return { workspace: createInitialWorkspace(), recoveryRequired: false };
    }

    const parsedValue = normalizeStoredWorkspace(JSON.parse(storedValue));
    if (!isValidWorkspace(parsedValue)) {
      return { workspace: emptyWorkspace, recoveryRequired: true };
    }

    if (isUntouchedEmptyWorkspace(parsedValue)) {
      return { workspace: createInitialWorkspace(), recoveryRequired: false };
    }

    return { workspace: parsedValue, recoveryRequired: false };
  } catch {
    return { workspace: emptyWorkspace, recoveryRequired: true };
  }
}

function updateActivePlan(workspace, updatePlan) {
  return {
    ...workspace,
    plans: workspace.plans.map((plan) =>
      plan.id === workspace.activePlanId ? updatePlan(plan) : plan,
    ),
  };
}

export function workspaceReducer(workspace, action) {
  switch (action.type) {
    case "workspace/import-add":
      return appendImportedWorkspace(workspace, action.workspace);
    case "workspace/import-replace":
      return action.workspace;
    case "plan/add": {
      const plan = {
        id: createId("plan"),
        name: action.name.trim(),
        guests: [],
        tables: [],
      };

      return appendPlan(workspace, plan);
    }
    case "plan/from-configuration": {
      const plan = createPlanFromConfiguration(action.configuration, createId);

      return appendPlan(workspace, plan);
    }
    case "plan/rename":
      return renamePlan(workspace, action.planId, action.name);
    case "plan/switch":
      return workspace.plans.some((plan) => plan.id === action.planId)
        ? { ...workspace, activePlanId: action.planId }
        : workspace;
    case "plan/duplicate":
      return duplicatePlan(workspace, action.planId, createId);
    case "plan/delete":
      return deletePlan(workspace, action.planId);
    case "guest/import":
      return updateActivePlan(workspace, (plan) => ({
        ...plan,
        guests: [
          ...plan.guests,
          ...action.names.map((name) => ({
            id: createId("guest"),
            name,
            tableId: null,
            position: null,
          })),
        ],
      }));
    case "guest/edit":
      return updateActivePlan(workspace, (plan) => ({
        ...plan,
        guests: plan.guests.map((guest) =>
          guest.id === action.guestId
            ? { ...guest, name: action.name.trim() }
            : guest,
        ),
      }));
    case "guest/delete":
      return updateActivePlan(workspace, (plan) => ({
        ...plan,
        guests: normalizeGuestPositions(
          plan.guests.filter((guest) => guest.id !== action.guestId),
        ),
      }));
    case "guest/move":
      return updateActivePlan(workspace, (plan) => {
        const validTableId = plan.tables.some(
          (table) => table.id === action.tableId,
        )
          ? action.tableId
          : null;
        return {
          ...plan,
          guests: moveGuestToPosition(
            plan.guests,
            action.guestId,
            validTableId,
            action.targetIndex,
          ),
        };
      });
    case "table/add":
      return updateActivePlan(workspace, (plan) => {
        const tableId = createId("table");

        return {
          ...plan,
          tables: recalculateTableNumbers([
            ...plan.tables,
            {
              id: tableId,
              name: action.name.trim(),
              capacity: action.capacity,
              provisional: false,
              category: "guests",
              notes: "",
            },
          ]),
          guests: [
            ...plan.guests,
            ...action.guestNames.map((name, index) => ({
              id: createId("guest"),
              name,
              tableId,
              position: index + 1,
            })),
          ],
        };
      });
    case "table/edit":
      return updateActivePlan(workspace, (plan) => {
        const currentTable = plan.tables.find(
          (table) => table.id === action.tableId,
        );
        if (!currentTable) return plan;

        return {
          ...plan,
          tables: recalculateTableNumbers(
            plan.tables.map((table) =>
              table.id === action.tableId
                ? {
                    ...table,
                    name: action.name.trim(),
                    capacity: action.capacity,
                  }
                : table,
            ),
          ),
        };
      });
    case "table/reorder":
      return updateActivePlan(workspace, (plan) => {
        const reorderedTables = reorderTables(
          plan.tables,
          action.tableId,
          action.targetIndex,
        );
        if (reorderedTables === plan.tables) return plan;

        return {
          ...plan,
          tables: reorderedTables,
        };
      });
    case "table/delete":
      return updateActivePlan(workspace, (plan) => {
        if (!plan.tables.some((table) => table.id === action.tableId)) {
          return plan;
        }

        return {
          ...plan,
          tables: recalculateTableNumbers(
            plan.tables.filter((table) => table.id !== action.tableId),
          ),
          guests: plan.guests.map((guest) =>
            guest.tableId === action.tableId
              ? { ...guest, tableId: null, position: null }
              : guest,
          ),
        };
      });
    default:
      return workspace;
  }
}

export function getPlanStats(plan) {
  const assigned = plan.guests.filter((guest) => guest.tableId !== null).length;
  const overflow = plan.tables.reduce((total, table) => {
    const occupancy = plan.guests.filter(
      (guest) => guest.tableId === table.id,
    ).length;
    return total + Math.max(0, occupancy - table.capacity);
  }, 0);

  return {
    tables: plan.tables.length,
    total: plan.guests.length,
    assigned,
    unassigned: plan.guests.length - assigned,
    overflow,
  };
}

function BotanicalBranch() {
  return (
    <svg className="botanical-branch" viewBox="0 0 430 145" aria-hidden="true">
      <path d="M12 126C112 112 161 82 225 18M144 94c11-28 28-41 48-50M196 48c28 6 47 18 62 34M86 111c1-24 11-42 29-57M113 102c27-3 48 3 66 17M242 21c34 9 63 28 85 57M273 40c-1 24 7 42 24 57M321 73c31 0 60 11 88 33" />
      <g>
        <ellipse
          cx="101"
          cy="68"
          rx="8"
          ry="20"
          transform="rotate(35 101 68)"
        />
        <ellipse
          cx="143"
          cy="74"
          rx="8"
          ry="21"
          transform="rotate(62 143 74)"
        />
        <ellipse
          cx="170"
          cy="53"
          rx="8"
          ry="20"
          transform="rotate(37 170 53)"
        />
        <ellipse
          cx="179"
          cy="112"
          rx="8"
          ry="20"
          transform="rotate(102 179 112)"
        />
        <ellipse
          cx="254"
          cy="73"
          rx="8"
          ry="21"
          transform="rotate(132 254 73)"
        />
        <ellipse
          cx="290"
          cy="82"
          rx="8"
          ry="20"
          transform="rotate(166 290 82)"
        />
        <ellipse
          cx="335"
          cy="79"
          rx="8"
          ry="21"
          transform="rotate(120 335 79)"
        />
        <ellipse
          cx="383"
          cy="98"
          rx="8"
          ry="20"
          transform="rotate(116 383 98)"
        />
      </g>
    </svg>
  );
}

function Modal({ title, description, children, onClose, className = "" }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? "modal-description" : undefined}
      >
        <button
          className="icon-button modal-close"
          onClick={onClose}
          aria-label="Chiudi"
        >
          ×
        </button>
        <p className="eyebrow">Miriam &amp; Ennio</p>
        <h2 id="modal-title">{title}</h2>
        {description && (
          <p id="modal-description" className="modal-description">
            {description}
          </p>
        )}
        {children}
      </section>
    </div>
  );
}

function NameDialog({
  title,
  description,
  fieldLabel = "Nome del piano",
  initialName = "",
  submitLabel,
  onSubmit,
  onClose,
}) {
  const [name, setName] = useState(initialName);

  return (
    <Modal title={title} description={description} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSubmit(name.trim());
        }}
      >
        <label className="field">
          <span>{fieldLabel}</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Es. Sala interna"
            required
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Annulla
          </button>
          <button className="button primary" type="submit">
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfigurationDialog({ configurations, onSubmit, onClose }) {
  const [configurationId, setConfigurationId] = useState(configurations[0].id);
  const configuration = configurations.find(
    (item) => item.id === configurationId,
  );
  const guestCount = configuration.tables.reduce(
    (total, table) => total + table.guests.length,
    0,
  );

  return (
    <Modal
      title="Crea da configurazione"
      description="Il preset verrà copiato in un nuovo piano. I piani esistenti non saranno modificati."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(configuration);
        }}
      >
        <label className="field">
          <span>Configurazione</span>
          <select
            autoFocus
            value={configurationId}
            onChange={(event) => setConfigurationId(event.target.value)}
          >
            {configurations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="configuration-preview">
          <strong>{configuration.name}</strong>
          <p>{configuration.description}</p>
          <span>
            {configuration.tables.length} tavoli · {guestCount} persone
          </span>
        </div>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Annulla
          </button>
          <button className="button primary" type="submit">
            Crea piano
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WorkspaceImportDialog({ existingPlanCount, onSubmit, onClose }) {
  const [fileName, setFileName] = useState("");
  const [importedWorkspace, setImportedWorkspace] = useState(null);
  const [importMode, setImportMode] = useState("add");
  const [error, setError] = useState("");
  const planCount = importedWorkspace?.plans.length ?? 0;
  const tableCount =
    importedWorkspace?.plans.reduce(
      (total, plan) => total + plan.tables.length,
      0,
    ) ?? 0;
  const guestCount =
    importedWorkspace?.plans.reduce(
      (total, plan) => total + plan.guests.length,
      0,
    ) ?? 0;
  const replacesWorkspace = importMode === "replace";

  async function handleFileChange(event) {
    const [file] = event.target.files;
    setFileName(file?.name ?? "");
    setImportedWorkspace(null);
    setError("");

    if (!file) return;

    try {
      setImportedWorkspace(parseWorkspaceImport(await readTextFile(file)));
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "Il file non può essere importato.",
      );
    }
  }

  return (
    <Modal
      title="Importa configurazione"
      description='Scegli un export JSON del pianificatore, modificabile anche a mano o con l’IA. I tavoli sono identificati come "tavolo N", senza UUID.'
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (importedWorkspace) onSubmit(importedWorkspace, importMode);
        }}
      >
        <label className="field file-field">
          <span>File JSON</span>
          <input
            autoFocus
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {importedWorkspace && (
          <>
            <div className="configuration-preview" role="status">
              <strong>{fileName}</strong>
              <p>
                {planCount} {planCount === 1 ? "piano" : "piani"} · {tableCount}{" "}
                tavoli · {guestCount} persone
              </p>
              <span>
                {replacesWorkspace
                  ? "Sostituirà tutti i piani salvati"
                  : `Si aggiungerà a ${existingPlanCount} ${
                      existingPlanCount === 1
                        ? "piano salvato"
                        : "piani salvati"
                    }`}
              </span>
            </div>
            <fieldset className="import-mode">
              <legend>Come importare</legend>
              <label>
                <input
                  type="radio"
                  name="import-mode"
                  value="add"
                  checked={importMode === "add"}
                  onChange={(event) => setImportMode(event.target.value)}
                />
                <span>
                  <strong>Aggiungi ai piani esistenti</strong>
                  <small>Conserva tutto ciò che è già salvato.</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="import-mode"
                  value="replace"
                  checked={importMode === "replace"}
                  onChange={(event) => setImportMode(event.target.value)}
                />
                <span>
                  <strong>Sostituisci tutti i piani</strong>
                  <small>
                    Usalo solo per ripristinare un archivio completo.
                  </small>
                </span>
              </label>
            </fieldset>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Annulla
          </button>
          <button
            className={`button ${replacesWorkspace ? "danger" : "primary"}`}
            type="submit"
            disabled={!importedWorkspace}
          >
            {replacesWorkspace ? "Importa e sostituisci" : "Aggiungi piani"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GuestImportDialog({ onSubmit, onClose }) {
  const [guestText, setGuestText] = useState("");
  const names = parseGuestLines(guestText);

  return (
    <Modal
      title="Aggiungi invitati"
      description="Scrivi un nome per riga. Gli omonimi resteranno persone distinte."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (names.length) onSubmit(names);
        }}
      >
        <label className="field">
          <span>Elenco degli invitati</span>
          <textarea
            autoFocus
            rows="8"
            value={guestText}
            onChange={(event) => setGuestText(event.target.value)}
            placeholder={"Giulia Romano\nMarco Bianchi\nAnna Verdi"}
            required
          />
        </label>
        <p className="form-hint">
          {names.length}{" "}
          {names.length === 1 ? "invitato pronto" : "invitati pronti"}
        </p>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Annulla
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!names.length}
          >
            Aggiungi invitati
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TableDialog({ table, onSubmit, onClose }) {
  const [name, setName] = useState(table?.name ?? "");
  const [capacity, setCapacity] = useState(table?.capacity ?? 10);
  const [guestText, setGuestText] = useState("");

  return (
    <Modal
      title={table ? "Modifica tavolo" : "Crea un tavolo"}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && Number(capacity) >= 1) {
            onSubmit({
              name: name.trim(),
              capacity: Number(capacity),
              guestNames: parseGuestLines(guestText),
            });
          }
        }}
      >
        <div className="field-row">
          <label className="field grow">
            <span>Nome del tavolo</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Es. Gelsomino"
              required
            />
          </label>
          <label className="field numeric-field">
            <span>Capienza</span>
            <input
              type="number"
              min="1"
              step="1"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
              required
            />
          </label>
        </div>
        {!table && (
          <label className="field">
            <span>
              Ospiti già assegnati <small>(facoltativo)</small>
            </span>
            <textarea
              rows="5"
              value={guestText}
              onChange={(event) => setGuestText(event.target.value)}
              placeholder="Un nome per riga"
            />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Annulla
          </button>
          <button className="button primary" type="submit">
            {table ? "Salva modifiche" : "Crea tavolo"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}) {
  return (
    <Modal
      title={title}
      description={description}
      onClose={onClose}
      className="confirm-modal"
    >
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Annulla
        </button>
        <button className="button danger" onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function GuestCard({
  guest,
  tables,
  onMove,
  onEdit,
  onDelete,
  overlay = false,
}) {
  const draggable = useDraggable({ id: guest.id, disabled: overlay });
  const style = draggable.transform
    ? {
        transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`,
      }
    : undefined;

  return (
    <article
      ref={draggable.setNodeRef}
      style={style}
      className={`guest-card ${draggable.isDragging ? "dragging" : ""} ${overlay ? "overlay" : ""}`}
    >
      <button
        className="drag-handle"
        aria-label={`Trascina ${guest.name}`}
        title="Trascina per spostare"
        {...draggable.attributes}
        {...draggable.listeners}
      >
        <span />
        <span />
        <span />
      </button>
      <span className="guest-name">{guest.name}</span>
      {!overlay && (
        <div className="guest-controls">
          {guest.tableId !== null && (
            <button
              className="mini-action unassign"
              onClick={() => onMove(null)}
              aria-label={`Rimetti ${guest.name} da sistemare`}
              title="Rimetti da sistemare"
            >
              ↩
            </button>
          )}
          <label className="move-control">
            <span className="sr-only">Sposta {guest.name}</span>
            <select
              aria-label={`Sposta ${guest.name}`}
              value={guest.tableId ?? ""}
              onChange={(event) => onMove(event.target.value || null)}
            >
              <option value="">Da sistemare</option>
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.number} · {table.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="mini-action"
            onClick={onEdit}
            aria-label={`Modifica ${guest.name}`}
          >
            ✎
          </button>
          <button
            className="mini-action delete"
            onClick={onDelete}
            aria-label={`Elimina ${guest.name}`}
          >
            ×
          </button>
        </div>
      )}
    </article>
  );
}

function GuestInsertionZones({ tableId, beforeIndex, afterIndex }) {
  const before = useDroppable({
    id: `guest-insert:${tableId}:${beforeIndex}:before`,
  });
  const after = useDroppable({
    id: `guest-insert:${tableId}:${afterIndex}:after`,
  });

  return (
    <>
      <div
        ref={before.setNodeRef}
        className="guest-insertion-zone before"
        aria-hidden="true"
      />
      <div
        ref={after.setNodeRef}
        className="guest-insertion-zone after"
        aria-hidden="true"
      />
    </>
  );
}

function GuestDropPlaceholder({ tableId, index }) {
  const droppable = useDroppable({
    id: `guest-placeholder:${tableId}:${index}`,
  });

  return (
    <div
      ref={droppable.setNodeRef}
      className={`guest-drop-placeholder ${droppable.isOver ? "drop-active" : ""}`}
      aria-label={`Nuova posizione ${index + 1} dell’invitato`}
    />
  );
}

function GuestList({
  guests,
  tables,
  onMove,
  onEdit,
  onDelete,
  emptyMessage,
  tableId = null,
  activeGuestId = null,
  dropTarget = null,
}) {
  const visibleGuests =
    tableId !== null && activeGuestId
      ? guests.filter((guest) => guest.id !== activeGuestId)
      : guests;
  const showPlaceholder = dropTarget?.tableId === tableId;

  if (!visibleGuests.length && !showPlaceholder) {
    return <p className="empty-copy">{emptyMessage}</p>;
  }

  return (
    <div className="guest-list">
      {visibleGuests.map((guest, index) => (
        <Fragment key={guest.id}>
          {showPlaceholder && dropTarget.targetIndex === index && (
            <GuestDropPlaceholder tableId={tableId} index={index} />
          )}
          <div className="guest-list-item">
            {tableId !== null && activeGuestId && (
              <GuestInsertionZones
                tableId={tableId}
                beforeIndex={index}
                afterIndex={index + 1}
              />
            )}
            <GuestCard
              guest={guest}
              tables={tables}
              onMove={(destinationTableId) =>
                onMove(guest.id, destinationTableId)
              }
              onEdit={() => onEdit(guest)}
              onDelete={() => onDelete(guest)}
            />
          </div>
        </Fragment>
      ))}
      {showPlaceholder && dropTarget.targetIndex === visibleGuests.length && (
        <GuestDropPlaceholder tableId={tableId} index={visibleGuests.length} />
      )}
      {tableId !== null && guests.length >= 3 && (
        <span
          className="circular-order-hint"
          aria-label="L’ultimo posto è accanto al primo"
          title="L’ultimo posto è accanto al primo"
        />
      )}
    </div>
  );
}

function UnassignedPanel({ guests, tables, actions, isOver }) {
  const droppable = useDroppable({ id: "unassigned" });

  return (
    <aside
      ref={droppable.setNodeRef}
      className={`unassigned-panel ${droppable.isOver || isOver ? "drop-active" : ""}`}
      aria-label="Invitati da sistemare"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">In attesa</p>
          <h2>Da sistemare</h2>
        </div>
        <span className="count-badge">{guests.length}</span>
      </div>
      <p className="panel-intro">
        Trascina ogni nome sul tavolo giusto, oppure usa il menu Sposta.
      </p>
      <button className="button primary full-width" onClick={actions.addGuests}>
        + Aggiungi invitati
      </button>
      <GuestList
        guests={guests}
        tables={tables}
        onMove={actions.moveGuest}
        onEdit={actions.editGuest}
        onDelete={actions.deleteGuest}
        emptyMessage="Tutti hanno trovato posto. Gli invitati aggiunti compariranno qui."
      />
    </aside>
  );
}

function TableCard({
  table,
  guests,
  tables,
  actions,
  tableReorderActive,
  activeGuestId,
  guestDropTarget,
}) {
  const droppable = useDroppable({
    id: `table:${table.id}`,
    disabled: tableReorderActive,
  });
  const draggable = useDraggable({ id: `table:${table.id}` });
  const overflow = Math.max(0, guests.length - table.capacity);
  const style = draggable.transform
    ? {
        transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`,
      }
    : undefined;

  const setTableCardRef = (node) => {
    droppable.setNodeRef(node);
    draggable.setNodeRef(node);
  };

  return (
    <article
      ref={setTableCardRef}
      style={style}
      className={`table-card ${overflow ? "over-capacity" : ""} ${droppable.isOver ? "drop-active" : ""} ${draggable.isDragging ? "dragging" : ""}`}
    >
      <div className="table-card-top">
        <div className="table-card-heading">
          <button
            ref={draggable.setActivatorNodeRef}
            className="table-drag-handle"
            aria-label={`Trascina tavolo ${table.name}`}
            title="Trascina per riordinare i tavoli"
            {...draggable.attributes}
            {...draggable.listeners}
          >
            <span />
            <span />
            <span />
          </button>
          <div>
            <p className="eyebrow table-label">
              Tavolo {String(table.number).padStart(2, "0")}
              {table.provisional && (
                <span title={table.notes || undefined}>Provvisorio</span>
              )}
            </p>
            <h3>{table.name}</h3>
          </div>
        </div>
        <div
          className="wax-badge"
          aria-label={`${guests.length} su ${table.capacity} posti`}
        >
          <strong>{guests.length}</strong>
          <span>/ {table.capacity}</span>
        </div>
      </div>
      {overflow > 0 && (
        <p className="overflow-notice" role="status">
          {overflow} {overflow === 1 ? "posto eccedente" : "posti eccedenti"}
        </p>
      )}
      <GuestList
        guests={guests}
        tables={tables}
        onMove={actions.moveGuest}
        onEdit={actions.editGuest}
        onDelete={actions.deleteGuest}
        emptyMessage="Tavolo libero. Trascina qui un invitato."
        tableId={table.id}
        activeGuestId={activeGuestId}
        dropTarget={guestDropTarget}
      />
      <div className="table-actions">
        <button
          className="text-button"
          onClick={() => actions.editTable(table)}
        >
          Rinomina / modifica
        </button>
        <button
          className="text-button danger-text"
          onClick={() => actions.deleteTable(table)}
        >
          Elimina
        </button>
      </div>
    </article>
  );
}

function TableInsertionZones({ tableId, beforeIndex, afterIndex }) {
  const before = useDroppable({
    id: `table-insert:${beforeIndex}:${tableId}:before`,
  });
  const after = useDroppable({
    id: `table-insert:${afterIndex}:${tableId}:after`,
  });

  return (
    <>
      <div
        ref={before.setNodeRef}
        className="table-insertion-zone before"
        aria-hidden="true"
      />
      <div
        ref={after.setNodeRef}
        className="table-insertion-zone after"
        aria-hidden="true"
      />
    </>
  );
}

function TableDropPlaceholder({ index }) {
  const droppable = useDroppable({ id: `table-placeholder:${index}` });

  return (
    <div
      ref={droppable.setNodeRef}
      className={`table-drop-placeholder ${droppable.isOver ? "drop-active" : ""}`}
      aria-label={`Nuova posizione ${index + 1} del tavolo`}
    >
      <span>Rilascia qui</span>
    </div>
  );
}

function TableDragOverlay({ table, guestCount }) {
  return (
    <article className="table-card table-overlay">
      <div className="table-card-top">
        <div>
          <p className="eyebrow table-label">
            Tavolo {String(table.number).padStart(2, "0")}
          </p>
          <h3>{table.name}</h3>
        </div>
        <div className="wax-badge" aria-hidden="true">
          <strong>{guestCount}</strong>
          <span>/ {table.capacity}</span>
        </div>
      </div>
    </article>
  );
}

function Stats({ stats }) {
  const items = [
    ["Tavoli", stats.tables],
    ["Invitati", stats.total],
    ["Assegnati", stats.assigned],
    ["Da sistemare", stats.unassigned],
    ["Posti eccedenti", stats.overflow],
  ];

  return (
    <dl className="stats" aria-label="Riepilogo del piano">
      {items.map(([label, value]) => (
        <div
          key={label}
          className={label === "Posti eccedenti" && value ? "stat-alert" : ""}
        >
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function getSyncStatusLabel(syncStatus) {
  return {
    loading: "Connessione a Supabase…",
    saving: "Salvataggio su Supabase…",
    synced: "Salvato su Supabase",
    error: "Supabase non raggiungibile · dati locali",
    local: "Salvataggio locale",
  }[syncStatus];
}

function Header({ workspace, activePlan, stats, actions, syncStatus }) {
  return (
    <header className="page-header">
      <BotanicalBranch />
      <div className="brand-block">
        <p className="wedding-date">17 ottobre 2026</p>
        <h1>
          I tavoli di <span>Miriam &amp; Ennio</span>
        </h1>
        <p className="subtitle">Un posto pensato per ogni persona cara.</p>
      </div>
      <div className="plan-toolbar">
        <label className="plan-select">
          <span>
            Piano attivo
            <small>
              {workspace.plans.length}{" "}
              {workspace.plans.length === 1 ? "piano salvato" : "piani salvati"}
            </small>
          </span>
          <select
            aria-label="Piano attivo"
            value={workspace.activePlanId}
            onChange={(event) => actions.switchPlan(event.target.value)}
          >
            {workspace.plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </label>
        <div className="plan-actions" aria-label="Azioni del piano">
          <div className="plan-action-group" role="group" aria-label="Piano">
            <span>Piano</span>
            <div>
              <button
                className="button compact primary"
                onClick={actions.addPlanFromConfiguration}
              >
                Da configurazione
              </button>
              <button
                className="button compact secondary"
                onClick={actions.addPlan}
              >
                Nuovo vuoto
              </button>
              <button
                className="button compact secondary"
                onClick={() => actions.duplicatePlan(activePlan)}
              >
                Duplica
              </button>
              <button
                className="button compact secondary"
                onClick={() => actions.renamePlan(activePlan)}
              >
                Rinomina
              </button>
              <button
                className="button compact secondary"
                onClick={() => actions.exportPlanHtml(activePlan)}
              >
                Esporta piano (HTML)
              </button>
              <button
                className="button compact ghost-danger"
                disabled={workspace.plans.length === 1}
                onClick={() => actions.deletePlan(activePlan)}
                title={
                  workspace.plans.length === 1
                    ? "L’ultimo piano non può essere eliminato"
                    : undefined
                }
              >
                Elimina
              </button>
            </div>
          </div>
          <div
            className="plan-action-group archive-actions"
            role="group"
            aria-label="Archivio"
          >
            <span>Archivio</span>
            <div>
              <button
                className="button compact secondary"
                onClick={actions.importWorkspace}
              >
                Importa JSON
              </button>
              <button
                className="button compact secondary"
                onClick={actions.exportWorkspace}
              >
                Esporta tutti (JSON)
              </button>
            </div>
          </div>
        </div>
      </div>
      <p className={`sync-status sync-${syncStatus}`} role="status">
        <span aria-hidden="true" />
        {getSyncStatusLabel(syncStatus)}
      </p>
      <Stats stats={stats} />
    </header>
  );
}

function StorageWarning({ onRecover }) {
  return (
    <div className="storage-warning" role="alert">
      <div>
        <strong>I dati salvati non sono leggibili.</strong>
        <span>
          {" "}
          È stato preparato un piano vuoto, ma il salvataggio precedente non
          verrà sostituito finché non confermi.
        </span>
      </div>
      <button className="button compact warning-button" onClick={onRecover}>
        Usa il piano vuoto
      </button>
    </div>
  );
}

export default function App() {
  const initialLoad = useMemo(() => loadWorkspace(), []);
  const [workspace, dispatch] = useReducer(
    workspaceReducer,
    initialLoad.workspace,
  );
  const [recoveryRequired, setRecoveryRequired] = useState(
    initialLoad.recoveryRequired,
  );
  const [remoteSyncEnabled, setRemoteSyncEnabled] = useState(false);
  const [syncStatus, setSyncStatus] = useState(
    isSupabaseConfigured ? "loading" : "local",
  );
  const [dialog, setDialog] = useState(null);
  const [activeGuestId, setActiveGuestId] = useState(null);
  const [activeTableId, setActiveTableId] = useState(null);
  const [guestDropTarget, setGuestDropTarget] = useState(null);
  const [tableDropIndex, setTableDropIndex] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor),
  );

  const activePlan = workspace.plans.find(
    (plan) => plan.id === workspace.activePlanId,
  );
  const stats = getPlanStats(activePlan);
  const orderedTables = [...activePlan.tables].sort(
    (first, second) => first.number - second.number,
  );
  const unassignedGuests = activePlan.guests.filter(
    (guest) => guest.tableId === null,
  );
  const activeGuest = activePlan.guests.find(
    (guest) => guest.id === activeGuestId,
  );
  const activeTable = orderedTables.find((table) => table.id === activeTableId);
  const visibleTables = activeTable
    ? orderedTables.filter((table) => table.id !== activeTable.id)
    : orderedTables;

  useEffect(() => {
    if (!recoveryRequired) {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(workspace));
    }
  }, [workspace, recoveryRequired]);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;

    let active = true;

    async function hydrateWorkspace() {
      try {
        const { workspace: remoteWorkspace, error } =
          await loadRemoteWorkspace();

        if (!active) return;
        if (error) throw error;

        if (remoteWorkspace) {
          const normalizedWorkspace = normalizeStoredWorkspace(remoteWorkspace);
          if (!isValidWorkspace(normalizedWorkspace)) {
            throw new Error("Il workspace remoto non è valido.");
          }

          dispatch({
            type: "workspace/import-replace",
            workspace: normalizedWorkspace,
          });
          setRecoveryRequired(false);
        }

        setRemoteSyncEnabled(true);
      } catch (error) {
        console.error("Impossibile caricare il workspace da Supabase", error);
        setSyncStatus("error");
      }
    }

    void hydrateWorkspace();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!remoteSyncEnabled) return undefined;

    setSyncStatus("saving");
    let active = true;
    const timeoutId = globalThis.setTimeout(async () => {
      try {
        await saveRemoteWorkspace(workspace);
        if (active) setSyncStatus("synced");
      } catch (error) {
        console.error("Impossibile salvare il workspace su Supabase", error);
        if (active) setSyncStatus("error");
      }
    }, 350);

    return () => {
      active = false;
      globalThis.clearTimeout(timeoutId);
    };
  }, [workspace, remoteSyncEnabled]);

  const closeDialog = () => setDialog(null);
  const moveGuest = (guestId, tableId) =>
    dispatch({ type: "guest/move", guestId, tableId });

  const actions = {
    switchPlan: (planId) => dispatch({ type: "plan/switch", planId }),
    addPlan: () => setDialog({ type: "add-plan" }),
    addPlanFromConfiguration: () =>
      setDialog({ type: "add-plan-from-configuration" }),
    importWorkspace: () => setDialog({ type: "import-workspace" }),
    exportWorkspace: () => downloadWorkspaceExport(workspace),
    exportPlanHtml: (plan) => downloadPlanHtmlExport(plan),
    renamePlan: (plan) => setDialog({ type: "rename-plan", plan }),
    duplicatePlan: (plan) =>
      dispatch({ type: "plan/duplicate", planId: plan.id }),
    deletePlan: (plan) => setDialog({ type: "delete-plan", plan }),
    addGuests: () => setDialog({ type: "add-guests" }),
    editGuest: (guest) => setDialog({ type: "edit-guest", guest }),
    deleteGuest: (guest) => setDialog({ type: "delete-guest", guest }),
    moveGuest,
    addTable: () => setDialog({ type: "add-table" }),
    editTable: (table) => setDialog({ type: "edit-table", table }),
    deleteTable: (table) => setDialog({ type: "delete-table", table }),
  };

  function resetDrag() {
    setActiveGuestId(null);
    setActiveTableId(null);
    setGuestDropTarget(null);
    setTableDropIndex(null);
  }

  function handleDragStart(event) {
    const activeId = String(event.active.id);
    if (activeId.startsWith("table:")) {
      const tableId = activeId.replace(/^table:/, "");
      setActiveTableId(tableId);
      setTableDropIndex(
        orderedTables.findIndex((table) => table.id === tableId),
      );
      return;
    }

    const guest = activePlan.guests.find(
      (candidate) => candidate.id === activeId,
    );
    setActiveGuestId(activeId);
    setGuestDropTarget(
      !guest || guest.tableId === null
        ? null
        : {
            tableId: guest.tableId,
            targetIndex: guest.position - 1,
          },
    );
  }

  function handleDragOver(event) {
    const activeId = String(event.active.id);
    if (activeId.startsWith("table:")) {
      const targetIndex = getTableDropIndex(event.over?.id);
      if (targetIndex !== null) setTableDropIndex(targetIndex);
      return;
    }

    const insertionTarget = getGuestDropTarget(event.over?.id);
    if (insertionTarget) {
      setGuestDropTarget(insertionTarget);
      return;
    }

    const targetId = String(event.over?.id ?? "");
    if (targetId.startsWith("table:")) {
      const tableId = targetId.replace(/^table:/, "");
      const targetIndex = getGuestsAtTable(
        activePlan.guests.filter((guest) => guest.id !== activeId),
        tableId,
      ).length;
      setGuestDropTarget({ tableId, targetIndex });
      return;
    }

    if (targetId === "unassigned") setGuestDropTarget(null);
  }

  function handleDragEnd(event) {
    const activeId = String(event.active.id);
    const targetId = event.over?.id;
    if (activeId.startsWith("table:")) {
      const targetIndex = getTableDropIndex(targetId) ?? tableDropIndex;
      if (targetIndex !== null) {
        dispatch({
          type: "table/reorder",
          tableId: activeId.replace(/^table:/, ""),
          targetIndex,
        });
      }
    } else if (targetId) {
      const insertionTarget = getGuestDropTarget(targetId);
      const tableTargetId = String(targetId).startsWith("table:")
        ? String(targetId).replace(/^table:/, "")
        : null;

      if (targetId === "unassigned") {
        moveGuest(activeId, null);
      } else if (insertionTarget) {
        dispatch({
          type: "guest/move",
          guestId: activeId,
          tableId: insertionTarget.tableId,
          targetIndex: insertionTarget.targetIndex,
        });
      } else if (tableTargetId) {
        moveGuest(activeId, tableTargetId);
      } else if (guestDropTarget) {
        dispatch({
          type: "guest/move",
          guestId: activeId,
          tableId: guestDropTarget.tableId,
          targetIndex: guestDropTarget.targetIndex,
        });
      }
    }
    resetDrag();
  }

  return (
    <>
      <style>{STYLES}</style>
      <div className="app-shell">
        {recoveryRequired && (
          <StorageWarning onRecover={() => setRecoveryRequired(false)} />
        )}
        <Header
          workspace={workspace}
          activePlan={activePlan}
          stats={stats}
          actions={actions}
          syncStatus={syncStatus}
        />
        <DndContext
          sensors={sensors}
          collisionDetection={detectDropTarget}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragCancel={resetDrag}
          onDragEnd={handleDragEnd}
        >
          <main className="planner-layout">
            <UnassignedPanel
              guests={unassignedGuests}
              tables={orderedTables}
              actions={actions}
            />
            <section className="tables-area" aria-labelledby="tables-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">La sala</p>
                  <h2 id="tables-title">Tavoli</h2>
                </div>
                <button className="button primary" onClick={actions.addTable}>
                  + Crea tavolo
                </button>
              </div>
              {activePlan.tables.length ? (
                <div className="tables-grid">
                  {visibleTables.map((table, index) => (
                    <Fragment key={table.id}>
                      {activeTable && tableDropIndex === index && (
                        <TableDropPlaceholder index={index} />
                      )}
                      <div className="table-grid-item">
                        {activeTable && (
                          <TableInsertionZones
                            tableId={table.id}
                            beforeIndex={index}
                            afterIndex={index + 1}
                          />
                        )}
                        <TableCard
                          table={table}
                          guests={getGuestsAtTable(activePlan.guests, table.id)}
                          tables={orderedTables}
                          actions={actions}
                          tableReorderActive={Boolean(activeTable)}
                          activeGuestId={activeGuestId}
                          guestDropTarget={guestDropTarget}
                        />
                      </div>
                    </Fragment>
                  ))}
                  {activeTable && tableDropIndex === visibleTables.length && (
                    <TableDropPlaceholder index={visibleTables.length} />
                  )}
                </div>
              ) : (
                <div className="tables-empty">
                  <BotanicalBranch />
                  <h3>La sala è ancora vuota</h3>
                  <p>
                    Crea il primo tavolo e comincia a comporre la disposizione.
                  </p>
                  <button className="button primary" onClick={actions.addTable}>
                    Crea il primo tavolo
                  </button>
                </div>
              )}
            </section>
          </main>
          <DragOverlay>
            {activeGuest ? (
              <GuestCard guest={activeGuest} tables={orderedTables} overlay />
            ) : activeTable ? (
              <TableDragOverlay
                table={activeTable}
                guestCount={
                  activePlan.guests.filter(
                    (guest) => guest.tableId === activeTable.id,
                  ).length
                }
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {dialog?.type === "add-plan" && (
        <NameDialog
          title="Crea un nuovo piano"
          description="Verrà aggiunto come scenario vuoto. Tutti i piani esistenti resteranno disponibili nel selettore."
          submitLabel="Crea piano"
          onClose={closeDialog}
          onSubmit={(name) => {
            dispatch({ type: "plan/add", name });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "add-plan-from-configuration" && (
        <ConfigurationDialog
          configurations={PLAN_CONFIGURATIONS}
          onClose={closeDialog}
          onSubmit={(configuration) => {
            dispatch({ type: "plan/from-configuration", configuration });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "import-workspace" && (
        <WorkspaceImportDialog
          existingPlanCount={workspace.plans.length}
          onClose={closeDialog}
          onSubmit={(importedWorkspace, importMode) => {
            dispatch({
              type:
                importMode === "replace"
                  ? "workspace/import-replace"
                  : "workspace/import-add",
              workspace: importedWorkspace,
            });
            setRecoveryRequired(false);
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "rename-plan" && (
        <NameDialog
          title="Rinomina il piano"
          initialName={dialog.plan.name}
          submitLabel="Salva nome"
          onClose={closeDialog}
          onSubmit={(name) => {
            dispatch({ type: "plan/rename", planId: dialog.plan.id, name });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "delete-plan" && (
        <ConfirmDialog
          title="Eliminare questo piano?"
          description={`“${dialog.plan.name}” e tutte le sue assegnazioni verranno eliminati definitivamente.`}
          confirmLabel="Elimina piano"
          onClose={closeDialog}
          onConfirm={() => {
            dispatch({ type: "plan/delete", planId: dialog.plan.id });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "add-guests" && (
        <GuestImportDialog
          onClose={closeDialog}
          onSubmit={(names) => {
            dispatch({ type: "guest/import", names });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "edit-guest" && (
        <NameDialog
          title="Modifica invitato"
          fieldLabel="Nome dell’invitato"
          initialName={dialog.guest.name}
          submitLabel="Salva nome"
          onClose={closeDialog}
          onSubmit={(name) => {
            dispatch({ type: "guest/edit", guestId: dialog.guest.id, name });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "delete-guest" && (
        <ConfirmDialog
          title="Eliminare questo invitato?"
          description={`${dialog.guest.name} verrà rimosso definitivamente dal piano.`}
          confirmLabel="Elimina invitato"
          onClose={closeDialog}
          onConfirm={() => {
            dispatch({ type: "guest/delete", guestId: dialog.guest.id });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "add-table" && (
        <TableDialog
          onClose={closeDialog}
          onSubmit={({ name, capacity, guestNames }) => {
            dispatch({
              type: "table/add",
              name,
              capacity,
              guestNames,
            });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "edit-table" && (
        <TableDialog
          table={dialog.table}
          onClose={closeDialog}
          onSubmit={({ name, capacity }) => {
            dispatch({
              type: "table/edit",
              tableId: dialog.table.id,
              name,
              capacity,
            });
            closeDialog();
          }}
        />
      )}
      {dialog?.type === "delete-table" && (
        <ConfirmDialog
          title="Eliminare questo tavolo?"
          description={`Gli ospiti di “${dialog.table.name}” torneranno tra quelli da sistemare.`}
          confirmLabel="Elimina tavolo"
          onClose={closeDialog}
          onConfirm={() => {
            dispatch({ type: "table/delete", tableId: dialog.table.id });
            closeDialog();
          }}
        />
      )}
    </>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);

const STYLES = `
@import url("https://fonts.googleapis.com/css2?family=Marcellus&family=Montserrat:wght@400;500;600;700&display=swap");

:root {
  --paper: #fbf8f2;
  --cream: #f4efe6;
  --olive: #506400;
  --olive-dark: #354200;
  --sage: #8a9570;
  --sage-light: #dfe3d4;
  --wax: #9f4f47;
  --wax-dark: #7d3731;
  --ink: #263020;
  --muted: #68705a;
  --line: rgba(80, 100, 0, 0.22);
  --shadow: 0 18px 45px rgba(54, 59, 30, 0.1);
  color: var(--ink);
  font-family: "Montserrat", sans-serif;
  font-synthesis: none;
  background: var(--cream);
}

* { box-sizing: border-box; }
html { min-width: 320px; background: var(--cream); }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input, textarea, select { font: inherit; }
button, select { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.46; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 3px solid rgba(159, 79, 71, 0.38);
  outline-offset: 3px;
}

.app-shell { min-height: 100vh; background: radial-gradient(circle at 12% 6%, #fff 0, transparent 26%), var(--cream); }
.page-header { position: relative; overflow: hidden; padding: 48px clamp(24px, 5vw, 72px) 30px; background: var(--paper); border-bottom: 1px solid var(--line); }
.page-header > .botanical-branch { position: absolute; right: -22px; top: -10px; width: min(36vw, 460px); opacity: 0.18; color: var(--olive); transform: rotate(-6deg); }
.botanical-branch path { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
.botanical-branch ellipse { fill: currentColor; opacity: 0.72; }
.brand-block { position: relative; max-width: 680px; }
.wedding-date, .eyebrow { margin: 0 0 7px; color: var(--olive); font-size: 0.68rem; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; }
h1, h2, h3 { margin: 0; font-family: "Marcellus", serif; font-weight: 400; color: var(--olive-dark); }
h1 { font-size: clamp(2.15rem, 5vw, 4.55rem); line-height: 0.99; letter-spacing: -0.035em; }
h1 span { color: var(--wax); }
h2 { font-size: clamp(1.7rem, 3vw, 2.25rem); }
h3 { font-size: 1.55rem; }
.subtitle { margin: 14px 0 0; color: var(--muted); font-size: 0.92rem; }
.plan-toolbar { position: relative; display: flex; align-items: flex-start; gap: 18px; margin-top: 34px; }
.plan-select { display: grid; gap: 7px; min-width: min(100%, 270px); }
.plan-select > span, .field > span { color: var(--muted); font-size: 0.69rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.plan-select > span { display: flex; justify-content: space-between; gap: 14px; }
.plan-select small { color: var(--sage); font-size: 0.62rem; letter-spacing: 0.03em; text-transform: none; }
.plan-select select, .field input, .field textarea, .field select { width: 100%; border: 1px solid var(--line); border-radius: 4px; color: var(--ink); background: #fffdfa; }
.plan-select select { min-height: 42px; padding: 0 36px 0 13px; }
.sync-status { position: relative; display: flex; align-items: center; gap: 7px; margin: 18px 0 0; color: var(--muted); font-size: 0.66rem; font-weight: 600; }
.sync-status span { width: 7px; height: 7px; border-radius: 50%; background: var(--sage); }
.sync-status.sync-loading span, .sync-status.sync-saving span { background: var(--wax); animation: sync-pulse 1.2s ease-in-out infinite; }
.sync-status.sync-synced span { background: var(--olive); }
.sync-status.sync-error { color: var(--wax-dark); }
.sync-status.sync-error span { background: var(--wax-dark); }
.plan-actions { display: flex; flex-wrap: wrap; gap: 17px; }
.plan-action-group { display: grid; gap: 7px; }
.plan-action-group > span { color: var(--muted); font-size: 0.61rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.plan-action-group > div { display: flex; flex-wrap: wrap; gap: 8px; }
.archive-actions { padding-left: 17px; border-left: 1px solid var(--line); }
.button { min-height: 43px; padding: 0 19px; border: 1px solid transparent; border-radius: 3px; font-size: 0.76rem; font-weight: 700; letter-spacing: 0.025em; transition: transform 160ms ease, background 160ms ease, box-shadow 160ms ease; }
.button:not(:disabled):hover { transform: translateY(-1px); }
.button.primary { color: white; background: var(--olive); box-shadow: 0 7px 20px rgba(80, 100, 0, 0.16); }
.button.primary:hover { background: var(--olive-dark); }
.button.secondary { color: var(--olive-dark); border-color: var(--line); background: transparent; }
.button.secondary:hover { background: rgba(80, 100, 0, 0.06); }
.button.compact { min-height: 36px; padding: 0 12px; font-size: 0.7rem; }
.button.ghost-danger { color: var(--wax-dark); border-color: rgba(159, 79, 71, 0.25); background: transparent; }
.button.danger { color: white; background: var(--wax); }
.full-width { width: 100%; }
.stats { position: absolute; right: clamp(24px, 5vw, 72px); bottom: 28px; display: grid; grid-template-columns: repeat(5, minmax(76px, auto)); margin: 0; border: 1px solid var(--line); background: rgba(251, 248, 242, 0.86); backdrop-filter: blur(8px); }
.stats > div { display: flex; flex-direction: column-reverse; justify-content: center; min-height: 67px; padding: 10px 18px; border-left: 1px solid var(--line); }
.stats > div:first-child { border-left: 0; }
.stats dt { margin-top: 4px; color: var(--muted); font-size: 0.59rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.stats dd { margin: 0; font-family: "Marcellus", serif; color: var(--olive-dark); font-size: 1.45rem; line-height: 1; }
.stats .stat-alert dd, .stats .stat-alert dt { color: var(--wax-dark); }
.storage-warning { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 12px clamp(24px, 5vw, 72px); color: #40241f; background: #eed6ce; border-bottom: 1px solid rgba(159, 79, 71, 0.3); font-size: 0.78rem; }
.warning-button { flex: none; color: white; background: var(--wax-dark); }

.planner-layout { display: grid; grid-template-columns: minmax(290px, 350px) 1fr; gap: clamp(24px, 3vw, 48px); max-width: 1600px; margin: 0 auto; padding: 42px clamp(24px, 5vw, 72px) 72px; align-items: start; }
.unassigned-panel { position: sticky; top: 20px; min-height: 420px; padding: 25px; border: 1px solid var(--line); background: rgba(251, 248, 242, 0.82); box-shadow: var(--shadow); transition: border-color 160ms ease, background 160ms ease; }
.unassigned-panel::before, .table-card::before { content: ""; position: absolute; inset: 6px; border: 1px solid rgba(80, 100, 0, 0.11); pointer-events: none; }
.panel-heading, .section-heading, .table-card-top { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.panel-intro { margin: 11px 0 20px; color: var(--muted); font-size: 0.76rem; line-height: 1.6; }
.count-badge { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; color: white; background: var(--sage); font-family: "Marcellus", serif; font-size: 1.1rem; }
.unassigned-panel > .guest-list { margin-top: 18px; max-height: calc(100vh - 310px); overflow: auto; padding-right: 2px; }
.tables-area { min-width: 0; }
.section-heading { margin-bottom: 20px; padding: 0 2px; }
.tables-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 22px; align-items: start; }
.table-grid-item { position: relative; min-width: 0; }
.table-card { position: relative; min-height: 265px; padding: 27px 25px 18px; border: 1px solid var(--line); background: var(--paper); box-shadow: 0 13px 35px rgba(54, 59, 30, 0.08); transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease; }
.table-card.dragging { z-index: 10; opacity: 0.72; box-shadow: 0 22px 48px rgba(37, 44, 21, 0.2); }
.table-grid-item:nth-child(3n + 1) .table-card { transform: rotate(-0.22deg); }
.table-grid-item:nth-child(3n + 2) .table-card { transform: rotate(0.18deg); }
.table-card:hover { box-shadow: 0 18px 42px rgba(54, 59, 30, 0.13); }
.table-card.over-capacity { border-color: rgba(159, 79, 71, 0.54); }
.table-card.drop-active, .unassigned-panel.drop-active { border-color: var(--olive); background: #f6f7ef; box-shadow: 0 0 0 4px rgba(80, 100, 0, 0.12), var(--shadow); }
.table-insertion-zone { position: absolute; z-index: 20; top: 0; bottom: 0; width: 50%; cursor: grabbing; }
.table-insertion-zone.before { left: 0; }
.table-insertion-zone.after { right: 0; }
.table-drop-placeholder { display: grid; place-items: center; min-height: 265px; border: 2px dashed var(--sage); color: var(--olive-dark); background: rgba(223, 227, 212, 0.34); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; animation: placeholder-in 140ms ease-out; }
.table-drop-placeholder.drop-active { border-color: var(--olive); background: rgba(223, 227, 212, 0.58); box-shadow: inset 0 0 0 5px rgba(80, 100, 0, 0.06); }
.table-overlay { width: min(360px, 80vw); min-height: 150px; pointer-events: none; box-shadow: 0 24px 52px rgba(37, 44, 21, 0.22); transform: rotate(1deg); }
.table-overlay::before { display: none; }
.table-card-heading { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.table-drag-handle { display: grid; flex: none; gap: 3px; margin-top: -5px; padding: 8px 5px; border: 0; color: var(--sage); background: transparent; cursor: grab; touch-action: none; }
.table-drag-handle:active { cursor: grabbing; }
.table-drag-handle span { display: block; width: 16px; height: 1px; background: currentColor; }
.table-label { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.table-label span { padding: 3px 6px 2px; border: 1px solid rgba(159, 79, 71, 0.3); color: var(--wax-dark); background: rgba(159, 79, 71, 0.06); font-size: 0.53rem; letter-spacing: 0.08em; }
.wax-badge { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 0 0 58px; width: 58px; height: 58px; color: white; background: var(--wax); border-radius: 47% 53% 49% 51% / 53% 45% 55% 47%; box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.17), 0 5px 10px rgba(91, 41, 35, 0.18); transform: rotate(3deg); }
.wax-badge::after { content: ""; position: absolute; inset: 4px; border: 1px solid rgba(255, 255, 255, 0.28); border-radius: inherit; }
.wax-badge strong { font-family: "Marcellus", serif; font-size: 1.22rem; line-height: 1; }
.wax-badge span { margin-top: 2px; font-size: 0.55rem; }
.overflow-notice { margin: 12px 0 -2px; color: var(--wax-dark); font-size: 0.68rem; font-weight: 700; text-align: right; }
.guest-list { position: relative; display: grid; gap: 7px; margin-top: 18px; }
.guest-list-item { position: relative; min-width: 0; }
.guest-insertion-zone { position: absolute; z-index: 4; right: 0; left: 0; height: 50%; cursor: grabbing; }
.guest-insertion-zone.before { top: 0; }
.guest-insertion-zone.after { bottom: 0; }
.guest-drop-placeholder { min-height: 43px; border: 1px dashed var(--sage); border-radius: 3px; background: rgba(223, 227, 212, 0.3); animation: placeholder-in 140ms ease-out; }
.guest-drop-placeholder.drop-active { border-color: var(--olive); background: rgba(223, 227, 212, 0.55); }
.circular-order-hint { position: absolute; z-index: 2; top: 21px; right: -10px; bottom: 21px; box-sizing: border-box; width: 10px; border: solid rgba(80, 100, 0, 0.62); border-width: 1.5px 1.5px 1.5px 0; border-radius: 0 3px 3px 0; pointer-events: none; }
.circular-order-hint::before { content: ""; position: absolute; top: -4px; left: -2px; width: 7px; height: 7px; background: var(--olive); clip-path: polygon(0 50%, 100% 0, 100% 100%); }
.circular-order-hint::after { content: ""; position: absolute; bottom: -3px; left: -2px; width: 5px; height: 5px; border-radius: 50%; background: var(--olive); }
.guest-card { position: relative; z-index: 1; display: grid; grid-template-columns: 23px minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 43px; padding: 5px 6px 5px 7px; border: 1px solid rgba(80, 100, 0, 0.15); border-radius: 3px; background: #fffdfa; box-shadow: 0 2px 7px rgba(48, 52, 28, 0.04); }
.guest-card.dragging { opacity: 0.28; }
.guest-card.overlay { width: min(340px, 80vw); box-shadow: 0 17px 35px rgba(37, 44, 21, 0.2); transform: rotate(1.5deg); }
.drag-handle { display: grid; gap: 2px; padding: 7px 4px; border: 0; background: transparent; touch-action: none; }
.drag-handle span { display: block; width: 13px; height: 1px; background: var(--sage); }
.guest-name { min-width: 0; overflow: hidden; color: var(--ink); font-size: 0.77rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.guest-controls { display: flex; align-items: center; gap: 3px; }
.move-control select { width: 32px; height: 30px; padding: 0; border: 0; color: transparent; background-color: transparent; background-image: linear-gradient(45deg, transparent 50%, var(--olive) 50%), linear-gradient(135deg, var(--olive) 50%, transparent 50%); background-position: calc(50% - 3px) 13px, calc(50% + 3px) 13px; background-size: 5px 5px; background-repeat: no-repeat; }
.move-control select option { color: var(--ink); }
.mini-action { width: 28px; height: 29px; padding: 0; border: 0; border-radius: 2px; color: var(--muted); background: transparent; font-size: 0.95rem; }
.mini-action:hover { color: var(--olive-dark); background: rgba(80, 100, 0, 0.07); }
.mini-action.unassign { color: var(--olive); font-size: 1.05rem; }
.mini-action.unassign:hover { color: var(--olive-dark); background: rgba(80, 100, 0, 0.1); }
.mini-action.delete:hover { color: var(--wax-dark); background: rgba(159, 79, 71, 0.08); }
.empty-copy { position: relative; margin: 23px 0 12px; padding: 18px 10px; border: 1px dashed rgba(80, 100, 0, 0.22); color: var(--muted); font-size: 0.73rem; line-height: 1.55; text-align: center; }
.table-actions { position: relative; display: flex; justify-content: flex-end; gap: 13px; margin-top: 17px; padding-top: 13px; border-top: 1px solid var(--line); }
.text-button { padding: 2px; border: 0; color: var(--olive); background: none; font-size: 0.67rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.danger-text { color: var(--wax-dark); }
.tables-empty { position: relative; display: grid; justify-items: center; overflow: hidden; min-height: 370px; padding: 80px 25px 50px; border: 1px dashed var(--line); color: var(--muted); text-align: center; }
.tables-empty .botanical-branch { position: absolute; top: -20px; right: -30px; width: 280px; color: var(--sage); opacity: 0.16; }
.tables-empty h3 { margin-bottom: 7px; }
.tables-empty p { max-width: 390px; margin: 0 0 24px; font-size: 0.8rem; line-height: 1.6; }

.modal-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(31, 38, 24, 0.62); backdrop-filter: blur(4px); animation: fade-in 150ms ease-out; }
.modal { position: relative; width: min(100%, 560px); max-height: calc(100vh - 40px); overflow: auto; padding: 34px; border: 1px solid rgba(80, 100, 0, 0.2); background: var(--paper); box-shadow: 0 28px 80px rgba(22, 26, 16, 0.28); animation: modal-in 180ms ease-out; }
.modal::before { content: ""; position: absolute; inset: 7px; border: 1px solid rgba(80, 100, 0, 0.1); pointer-events: none; }
.modal h2 { position: relative; margin-right: 30px; }
.modal-description { position: relative; margin: 10px 0 22px; color: var(--muted); font-size: 0.78rem; line-height: 1.6; }
.modal-close { position: absolute; z-index: 2; top: 18px; right: 18px; }
.icon-button { width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%; color: var(--muted); background: rgba(80, 100, 0, 0.06); font-size: 1.25rem; }
.modal form { position: relative; margin-top: 24px; }
.field { display: grid; gap: 7px; margin-bottom: 18px; }
.field input, .field select { min-height: 46px; padding: 0 13px; }
.field textarea { resize: vertical; padding: 12px 13px; line-height: 1.5; }
.file-field input { min-height: 48px; padding: 9px; }
.file-field input::file-selector-button { min-height: 28px; margin-right: 11px; padding: 0 11px; border: 1px solid var(--line); border-radius: 2px; color: var(--olive-dark); background: var(--cream); font-weight: 700; cursor: pointer; }
.field small { color: var(--sage); font-size: inherit; }
.field-row { display: flex; gap: 14px; }
.field-row .grow { flex: 1; }
.numeric-field { flex: 0 0 105px; }
.form-hint { margin: -8px 0 18px; color: var(--sage); font-size: 0.69rem; font-weight: 600; }
.form-error { margin: -8px 0 18px; color: var(--wax-dark); font-size: 0.69rem; font-weight: 600; }
.configuration-preview { margin-top: 4px; padding: 18px; border: 1px solid var(--line); background: rgba(223, 227, 212, 0.28); }
.configuration-preview strong { font-family: "Marcellus", serif; color: var(--olive-dark); font-size: 1.15rem; font-weight: 400; }
.configuration-preview p { margin: 7px 0 12px; color: var(--muted); font-size: 0.75rem; line-height: 1.55; }
.configuration-preview span { color: var(--olive); font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.import-mode { display: grid; gap: 8px; margin: 18px 0 0; padding: 0; border: 0; }
.import-mode legend { margin-bottom: 8px; color: var(--muted); font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.import-mode label { display: flex; align-items: flex-start; gap: 11px; padding: 13px; border: 1px solid var(--line); background: rgba(251, 248, 242, 0.7); cursor: pointer; }
.import-mode input { flex: none; margin-top: 3px; accent-color: var(--olive); }
.import-mode label > span { display: grid; gap: 3px; }
.import-mode strong { color: var(--olive-dark); font-size: 0.75rem; }
.import-mode small { color: var(--muted); font-size: 0.68rem; line-height: 1.4; }
.modal-actions { position: relative; display: flex; justify-content: flex-end; gap: 9px; margin-top: 28px; }
.confirm-modal { width: min(100%, 480px); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@keyframes fade-in { from { opacity: 0; } }
@keyframes modal-in { from { opacity: 0; transform: translateY(8px) scale(0.985); } }
@keyframes sync-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
@keyframes placeholder-in { from { opacity: 0.3; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }

@media (max-width: 1540px) {
  .stats { position: relative; right: auto; bottom: auto; width: fit-content; margin: 28px 0 0; }
  .plan-toolbar { margin-top: 28px; }
}

@media (max-width: 760px) {
  .page-header { padding: 32px 18px 22px; }
  .page-header > .botanical-branch { width: 260px; opacity: 0.12; }
  h1 { font-size: clamp(2.15rem, 12vw, 3rem); }
  h1 span { display: block; }
  .plan-toolbar { display: grid; align-items: stretch; }
  .plan-select { width: 100%; }
  .plan-actions { display: grid; grid-template-columns: 1fr; }
  .plan-action-group > div { display: grid; grid-template-columns: repeat(2, 1fr); }
  .plan-action-group .button { width: 100%; }
  .plan-action-group .ghost-danger:last-child { grid-column: span 2; }
  .archive-actions { padding: 16px 0 0; border-top: 1px solid var(--line); border-left: 0; }
  .stats { width: 100%; grid-template-columns: repeat(2, 1fr); }
  .stats > div { min-height: 60px; border-top: 1px solid var(--line); }
  .stats > div:nth-child(odd) { border-left: 0; }
  .stats > div:nth-child(-n + 2) { border-top: 0; }
  .stats > div:last-child { grid-column: span 2; }
  .storage-warning { align-items: stretch; flex-direction: column; padding: 14px 18px; }
  .planner-layout { grid-template-columns: 1fr; gap: 34px; padding: 25px 18px 55px; }
  .unassigned-panel { position: relative; top: 0; min-height: 0; padding: 22px 18px; }
  .unassigned-panel > .guest-list { max-height: none; }
  .section-heading { align-items: flex-end; }
  .tables-grid { grid-template-columns: 1fr; }
  .table-card { padding: 24px 19px 17px; }
  .circular-order-hint { right: -7px; width: 7px; }
  .table-insertion-zone { right: 0; left: 0; width: auto; height: 50%; }
  .table-insertion-zone.before { top: 0; bottom: auto; }
  .table-insertion-zone.after { top: auto; bottom: 0; }
  .field-row { flex-wrap: wrap; }
  .field-row .grow { flex-basis: 100%; }
  .numeric-field { flex: 1; }
  .modal { padding: 31px 22px 23px; }
  .field-row { display: block; }
  .guest-card { grid-template-columns: 22px minmax(80px, 1fr) auto; }
}

@media (max-width: 420px) {
  .section-heading { align-items: stretch; flex-direction: column; }
  .section-heading .button { width: 100%; }
  .guest-controls { gap: 0; }
  .modal-actions .button { flex: 1; padding-inline: 10px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;
