import { describe, expect, it } from "vitest";

import {
  getGuestsAtTable,
  hasSequentialGuestPositions,
  moveGuestToPosition,
  normalizeGuestPositions,
} from "./guest-order.js";

const GUESTS = [
  { id: "anna", name: "Anna", tableId: "ulivo", position: 1 },
  { id: "luca", name: "Luca", tableId: "ulivo", position: 2 },
  { id: "marta", name: "Marta", tableId: "ulivo", position: 3 },
  { id: "paolo", name: "Paolo", tableId: "quercia", position: 1 },
];

function seating(guests, tableId) {
  return getGuestsAtTable(guests, tableId).map(({ id, position }) => ({
    id,
    position,
  }));
}

describe("ordine dei posti", () => {
  it("migra i vecchi invitati mantenendo l’ordine già visibile", () => {
    const legacyGuests = GUESTS.map(({ id, name, tableId }) => ({
      id,
      name,
      tableId,
    }));

    expect(normalizeGuestPositions(legacyGuests)).toMatchObject([
      { id: "anna", position: 1 },
      { id: "luca", position: 2 },
      { id: "marta", position: 3 },
      { id: "paolo", position: 1 },
    ]);
  });

  it("inserisce un invitato tra due posti e ricompatta lo stesso tavolo", () => {
    const movedGuests = moveGuestToPosition(GUESTS, "marta", "ulivo", 1);

    expect(seating(movedGuests, "ulivo")).toEqual([
      { id: "anna", position: 1 },
      { id: "marta", position: 2 },
      { id: "luca", position: 3 },
    ]);
    expect(hasSequentialGuestPositions(movedGuests)).toBe(true);
  });

  it("inserisce tra tavoli ricompattando sia la partenza sia la destinazione", () => {
    const movedGuests = moveGuestToPosition(GUESTS, "luca", "quercia", 0);

    expect(seating(movedGuests, "ulivo")).toEqual([
      { id: "anna", position: 1 },
      { id: "marta", position: 2 },
    ]);
    expect(seating(movedGuests, "quercia")).toEqual([
      { id: "luca", position: 1 },
      { id: "paolo", position: 2 },
    ]);
    expect(hasSequentialGuestPositions(movedGuests)).toBe(true);
  });

  it("libera il posto quando un invitato torna da sistemare", () => {
    const movedGuests = moveGuestToPosition(GUESTS, "luca", null);

    expect(movedGuests.find((guest) => guest.id === "luca")).toMatchObject({
      tableId: null,
      position: null,
    });
    expect(seating(movedGuests, "ulivo")).toEqual([
      { id: "anna", position: 1 },
      { id: "marta", position: 2 },
    ]);
  });
});
