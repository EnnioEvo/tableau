function compareGuestPositions(firstGuest, secondGuest) {
  const firstPosition = Number.isInteger(firstGuest.position)
    ? firstGuest.position
    : Number.POSITIVE_INFINITY;
  const secondPosition = Number.isInteger(secondGuest.position)
    ? secondGuest.position
    : Number.POSITIVE_INFINITY;

  return firstPosition - secondPosition;
}

export function getGuestsAtTable(guests, tableId) {
  return guests
    .filter((guest) => guest.tableId === tableId)
    .sort(compareGuestPositions);
}

export function normalizeGuestPositions(guests) {
  const positions = new Map();
  const tableIds = new Set(
    guests
      .filter((guest) => guest.tableId !== null)
      .map((guest) => guest.tableId),
  );

  for (const tableId of tableIds) {
    getGuestsAtTable(guests, tableId).forEach((guest, index) => {
      positions.set(guest.id, index + 1);
    });
  }

  return guests.map((guest) => ({
    ...guest,
    position: guest.tableId === null ? null : positions.get(guest.id),
  }));
}

function hasValidGuestPosition(guest) {
  if (!guest || typeof guest !== "object") return false;
  if (guest.tableId === null) return guest.position === null;

  return Number.isInteger(guest.position) && guest.position > 0;
}

export function hasSequentialGuestPositions(guests) {
  if (!guests.every(hasValidGuestPosition)) return false;

  const tableIds = new Set(
    guests
      .filter((guest) => guest.tableId !== null)
      .map((guest) => guest.tableId),
  );

  return [...tableIds].every((tableId) =>
    getGuestsAtTable(guests, tableId).every(
      (guest, index) => guest.position === index + 1,
    ),
  );
}

function assignPositions(guests, orderedGuests, tableId) {
  const positions = new Map(
    orderedGuests.map((guest, index) => [guest.id, index + 1]),
  );

  return guests.map((guest) =>
    positions.has(guest.id)
      ? { ...guest, tableId, position: positions.get(guest.id) }
      : guest,
  );
}

export function moveGuestToPosition(
  guests,
  guestId,
  destinationTableId,
  targetIndex,
) {
  const movedGuest = guests.find((guest) => guest.id === guestId);
  if (!movedGuest) return guests;

  const sourceTableId = movedGuest.tableId;
  if (destinationTableId === null) {
    if (sourceTableId === null) return guests;

    const sourceGuests = getGuestsAtTable(guests, sourceTableId).filter(
      (guest) => guest.id !== guestId,
    );
    const compactedGuests = assignPositions(
      guests,
      sourceGuests,
      sourceTableId,
    );

    return compactedGuests.map((guest) =>
      guest.id === guestId
        ? { ...guest, tableId: null, position: null }
        : guest,
    );
  }

  const destinationGuests = getGuestsAtTable(guests, destinationTableId).filter(
    (guest) => guest.id !== guestId,
  );
  const insertionIndex = Number.isInteger(targetIndex)
    ? Math.max(0, Math.min(targetIndex, destinationGuests.length))
    : destinationGuests.length;

  if (
    sourceTableId === destinationTableId &&
    getGuestsAtTable(guests, sourceTableId).findIndex(
      (guest) => guest.id === guestId,
    ) === insertionIndex
  ) {
    return guests;
  }

  destinationGuests.splice(insertionIndex, 0, movedGuest);
  let updatedGuests = guests;

  if (sourceTableId !== null && sourceTableId !== destinationTableId) {
    const sourceGuests = getGuestsAtTable(guests, sourceTableId).filter(
      (guest) => guest.id !== guestId,
    );
    updatedGuests = assignPositions(updatedGuests, sourceGuests, sourceTableId);
  }

  return assignPositions(updatedGuests, destinationGuests, destinationTableId);
}
