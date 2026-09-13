import { getGuestsAtTable } from "./guest-order.js";

const HTML_EXPORT_TITLE = "I tavoli di Miriam & Ennio";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getPlanStats(plan) {
  const assigned = plan.guests.filter((guest) => guest.tableId !== null).length;
  const overflow = plan.tables.reduce((total, table) => {
    const occupancy = plan.guests.filter(
      (guest) => guest.tableId === table.id,
    ).length;

    return total + Math.max(0, occupancy - table.capacity);
  }, 0);

  return {
    tables: plan.tables.length,
    guests: plan.guests.length,
    assigned,
    unassigned: plan.guests.length - assigned,
    overflow,
  };
}

function renderGuestList(guests) {
  if (guests.length === 0) {
    return '<p class="empty-list">Nessuna persona assegnata</p>';
  }

  return `<ol class="guest-list">${guests
    .map((guest) => `<li>${escapeHtml(guest.name)}</li>`)
    .join("")}</ol>`;
}

function renderTable(plan, table) {
  const guests = getGuestsAtTable(plan.guests, table.id);
  const overflow = Math.max(0, guests.length - table.capacity);
  const labels = [
    table.provisional ? '<span class="tag">Provvisorio</span>' : "",
    table.category === "staff" ? '<span class="tag">Staff</span>' : "",
  ].join("");
  const notes = table.notes
    ? `<p class="table-notes">${escapeHtml(table.notes)}</p>`
    : "";
  const overflowNotice = overflow
    ? `<p class="overflow">${overflow} ${overflow === 1 ? "posto eccedente" : "posti eccedenti"}</p>`
    : "";

  return `
    <article class="table-card${overflow ? " over-capacity" : ""}">
      <header class="table-heading">
        <div>
          <p class="table-number">Tavolo ${escapeHtml(table.number)} ${labels}</p>
          <h2>${escapeHtml(table.name)}</h2>
        </div>
        <div class="capacity" aria-label="${guests.length} persone su ${escapeHtml(table.capacity)} posti">
          <strong>${guests.length}</strong>
          <span>/ ${escapeHtml(table.capacity)}</span>
        </div>
      </header>
      ${notes}
      ${overflowNotice}
      ${renderGuestList(guests)}
    </article>`;
}

function renderWaitingGuests(guests) {
  return `
    <section class="waiting-section">
      <div>
        <p class="eyebrow">Persone non assegnate</p>
        <h2>Da sistemare</h2>
      </div>
      ${
        guests.length
          ? `<ul>${guests.map((guest) => `<li>${escapeHtml(guest.name)}</li>`).join("")}</ul>`
          : '<p class="waiting-empty">Tutte le persone hanno un tavolo.</p>'
      }
    </section>`;
}

export function serializePlanAsHtml(plan, exportedAt = new Date()) {
  const stats = getPlanStats(plan);
  const tables = [...plan.tables].sort(
    (first, second) => first.number - second.number,
  );
  const unassignedGuests = plan.guests.filter(
    (guest) => guest.tableId === null,
  );
  const exportedDate = new Intl.DateTimeFormat("it-IT", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(exportedAt);

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(plan.name)} · ${HTML_EXPORT_TITLE}</title>
  <style>
    :root { --paper: #fbf8f2; --cream: #f4efe6; --olive: #506400; --olive-dark: #354200; --sage: #8a9570; --wax: #9f4f47; --wax-dark: #7d3731; --ink: #263020; --muted: #68705a; --line: rgba(80, 100, 0, .24); }
    * { box-sizing: border-box; }
    html { color: var(--ink); background: var(--cream); font-family: Montserrat, Avenir, "Segoe UI", sans-serif; }
    body { min-width: 320px; margin: 0; background: radial-gradient(circle at 12% 3%, #fff 0, transparent 20%), var(--cream); }
    .document { width: min(100%, 1580px); margin: 0 auto; padding: 48px clamp(22px, 4vw, 64px) 64px; }
    .hero { position: relative; overflow: hidden; margin-bottom: 30px; padding: 34px 36px 28px; border: 1px solid var(--line); background: var(--paper); }
    .botanical { position: absolute; top: -20px; right: -20px; width: min(38vw, 430px); color: var(--olive); opacity: .14; transform: rotate(-5deg); }
    .botanical path { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
    .botanical ellipse { fill: currentColor; opacity: .72; }
    .eyebrow { margin: 0 0 7px; color: var(--olive); font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    h1, h2 { margin: 0; color: var(--olive-dark); font-family: Marcellus, Georgia, serif; font-weight: 400; }
    h1 { position: relative; max-width: 900px; font-size: clamp(34px, 5vw, 64px); line-height: 1; }
    h1 span { color: var(--wax); }
    .plan-name { position: relative; margin: 13px 0 0; color: var(--muted); font-size: 15px; }
    .stats { position: relative; display: grid; grid-template-columns: repeat(5, minmax(90px, 1fr)); max-width: 760px; margin: 28px 0 0; border: 1px solid var(--line); }
    .stat { min-height: 66px; padding: 11px 14px; border-left: 1px solid var(--line); background: rgba(255, 253, 250, .74); }
    .stat:first-child { border-left: 0; }
    .stat strong { display: block; color: var(--olive-dark); font-family: Marcellus, Georgia, serif; font-size: 23px; font-weight: 400; }
    .stat span { color: var(--muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .stat.alert strong, .stat.alert span { color: var(--wax-dark); }
    .tables-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; align-items: start; }
    .table-card { break-inside: avoid; min-width: 0; padding: 24px 22px 20px; border: 1px solid var(--line); background: var(--paper); box-shadow: 0 10px 28px rgba(54, 59, 30, .07); }
    .table-card.over-capacity { border-color: rgba(159, 79, 71, .6); }
    .table-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .table-number { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 5px; color: var(--olive); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .tag { padding: 2px 5px; border: 1px solid rgba(159, 79, 71, .3); color: var(--wax-dark); font-size: 8px; letter-spacing: .08em; }
    .table-card h2 { font-size: 24px; line-height: 1.08; }
    .capacity { display: flex; flex: 0 0 54px; width: 54px; height: 54px; align-items: baseline; justify-content: center; padding-top: 15px; color: #fff; border-radius: 47% 53% 49% 51% / 53% 45% 55% 47%; background: var(--wax); transform: rotate(2deg); }
    .capacity strong { font-family: Marcellus, Georgia, serif; font-size: 20px; font-weight: 400; }
    .capacity span { font-size: 10px; }
    .table-notes { margin: 12px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .overflow { margin: 12px 0 -2px; color: var(--wax-dark); font-size: 10px; font-weight: 700; text-align: right; }
    .guest-list { columns: 2; column-gap: 25px; margin: 18px 0 0; padding: 15px 0 0 21px; border-top: 1px solid var(--line); }
    .guest-list li { break-inside: avoid; margin: 0 0 7px; padding-left: 3px; font-size: 11px; line-height: 1.35; }
    .guest-list li::marker { color: var(--sage); font-size: 9px; }
    .empty-list { margin: 18px 0 0; padding-top: 15px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; font-style: italic; }
    .waiting-section { display: flex; align-items: flex-start; gap: 32px; margin-top: 24px; padding: 24px; border: 1px dashed var(--line); background: rgba(251, 248, 242, .72); }
    .waiting-section > div { flex: 0 0 190px; }
    .waiting-section h2 { font-size: 25px; }
    .waiting-section ul { display: grid; flex: 1; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 24px; margin: 0; padding-left: 18px; }
    .waiting-section li, .waiting-empty { color: var(--muted); font-size: 11px; line-height: 1.4; }
    .waiting-empty { margin: 5px 0 0; }
    .document-footer { margin-top: 24px; color: var(--muted); font-size: 9px; text-align: right; }
    @media (max-width: 980px) { .tables-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 640px) { .document { padding: 18px 14px 36px; } .hero { padding: 26px 22px 22px; } .stats { grid-template-columns: repeat(2, 1fr); } .stat { border-top: 1px solid var(--line); } .stat:nth-child(odd) { border-left: 0; } .tables-grid { grid-template-columns: 1fr; } .waiting-section { display: block; } .waiting-section ul { grid-template-columns: 1fr; margin-top: 18px; } }
    @page { size: A4 landscape; margin: 10mm; }
    @media print { body { background: #fff; } .document { width: 100%; padding: 0; } .hero { margin-bottom: 5mm; padding: 7mm; } h1 { font-size: 34px; } .stats { margin-top: 6mm; } .tables-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4mm; } .table-card { padding: 5mm; box-shadow: none; } .table-card h2 { font-size: 19px; } .guest-list { columns: 1; } .waiting-section { margin-top: 5mm; } }
  </style>
</head>
<body>
  <main class="document">
    <header class="hero">
      <svg class="botanical" viewBox="0 0 430 145" aria-hidden="true">
        <path d="M12 126C112 112 161 82 225 18M144 94c11-28 28-41 48-50M196 48c28 6 47 18 62 34M86 111c1-24 11-42 29-57M113 102c27-3 48 3 66 17M242 21c34 9 63 28 85 57M273 40c-1 24 7 42 24 57M321 73c31 0 60 11 88 33"/>
        <ellipse cx="101" cy="68" rx="8" ry="20" transform="rotate(35 101 68)"/><ellipse cx="143" cy="74" rx="8" ry="21" transform="rotate(62 143 74)"/><ellipse cx="179" cy="112" rx="8" ry="20" transform="rotate(102 179 112)"/><ellipse cx="273" cy="40" rx="8" ry="20" transform="rotate(115 273 40)"/><ellipse cx="328" cy="77" rx="8" ry="21" transform="rotate(129 328 77)"/>
      </svg>
      <p class="eyebrow">17 ottobre 2026</p>
      <h1>I tavoli di <span>Miriam &amp; Ennio</span></h1>
      <p class="plan-name">${escapeHtml(plan.name)}</p>
      <div class="stats" aria-label="Riepilogo del piano">
        <div class="stat"><strong>${stats.tables}</strong><span>Tavoli</span></div>
        <div class="stat"><strong>${stats.guests}</strong><span>Invitati</span></div>
        <div class="stat"><strong>${stats.assigned}</strong><span>Assegnati</span></div>
        <div class="stat"><strong>${stats.unassigned}</strong><span>Da sistemare</span></div>
        <div class="stat${stats.overflow ? " alert" : ""}"><strong>${stats.overflow}</strong><span>Posti eccedenti</span></div>
      </div>
    </header>
    <section class="tables-grid" aria-label="Tavoli">
      ${tables.map((table) => renderTable(plan, table)).join("")}
    </section>
    ${renderWaitingGuests(unassignedGuests)}
    <footer class="document-footer">Esportato il ${escapeHtml(exportedDate)} · Documento in sola lettura</footer>
  </main>
</body>
</html>`;
}

export function createPlanHtmlExportFilename(plan, exportedAt = new Date()) {
  const date = exportedAt.toISOString().slice(0, 10);
  const planName = plan.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  return `tavoli-${planName || "piano"}-${date}.html`;
}

export function downloadPlanHtmlExport(plan) {
  const exportedAt = new Date();
  const blob = new Blob([serializePlanAsHtml(plan, exportedAt)], {
    type: "text/html;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = createPlanHtmlExportFilename(plan, exportedAt);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
