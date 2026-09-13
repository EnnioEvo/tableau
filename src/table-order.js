export function recalculateTableNumbers(tables) {
  return tables.map((table, index) => ({ ...table, number: index + 1 }));
}

export function migrateTableOrder(tables) {
  const orderedTables = [...tables].sort((first, second) => {
    const firstNumber = Number.isInteger(first?.number)
      ? first.number
      : Number.POSITIVE_INFINITY;
    const secondNumber = Number.isInteger(second?.number)
      ? second.number
      : Number.POSITIVE_INFINITY;

    return firstNumber - secondNumber;
  });

  return recalculateTableNumbers(orderedTables);
}

export function reorderTables(tables, tableId, targetIndex) {
  const sourceIndex = tables.findIndex((table) => table.id === tableId);
  if (
    sourceIndex === -1 ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= tables.length ||
    sourceIndex === targetIndex
  ) {
    return tables;
  }

  const reorderedTables = [...tables];
  const [movedTable] = reorderedTables.splice(sourceIndex, 1);
  reorderedTables.splice(targetIndex, 0, movedTable);

  return recalculateTableNumbers(reorderedTables);
}
